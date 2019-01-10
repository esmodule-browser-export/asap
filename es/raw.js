class Raw {

    // Use the fastest means possible to execute a task in its own turn, with
    // priority over other events including IO, animation, reflow, and redraw
    // events in browsers.
    //
    // An exception thrown by a task will permanently interrupt the processing of
    // subsequent tasks. The higher level `asap` function ensures that if an
    // exception is thrown by a task, that the task queue will continue flushing as
    // soon as possible, but if you use `rawAsap` directly, you are responsible to
    // either ensure that no exceptions are thrown from your task, or to manually
    // call `rawAsap.requestFlush` if an exception is thrown.
    constructor() {
        this.queue = []
        // Once a flush has been requested, no further calls to `requestFlush` are
        // necessary until the next `flush` completes.
        this.flushing = false
        // `requestFlush` is an implementation-specific method that attempts to kick
        // off a `flush` event as quickly as possible. `flush` will attempt to exhaust
        // the event queue before yielding to the browser's own event loop.

        // The position of the next task to execute in the task queue. This is
        // preserved between calls to `flush` so that it can be resumed if
        // a task throws an exception.
        this.index = 0
        // If a task schedules additional tasks recursively, the task queue can grow
        // unbounded. To prevent memory exhaustion, the task queue will periodically
        // truncate already-completed tasks.
        this.capacity = 1024


        this.flush = this.flush.bind(this)

        // `requestFlush` is implemented using a strategy based on data collected from
        // every available SauceLabs Selenium web driver worker at time of writing.
        // https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

        // Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
        // have WebKitMutationObserver but not un-prefixed MutationObserver.
        // Must use `global` or `self` instead of `window` to work in both frames and web
        // workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.

        this.scope = typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : self)
        this.BrowserMutationObserver = this.scope.MutationObserver || this.scope.WebKitMutationObserver;

        // MutationObservers are desirable because they have high priority and work
        // reliably everywhere they are implemented.
        // They are implemented in all modern browsers.
        //
        // - Android 4-4.3
        // - Chrome 26-34
        // - Firefox 14-29
        // - Internet Explorer 11
        // - iPad Safari 6-7.1
        // - iPhone Safari 7-7.1
        // - Safari 6-7
        this.makeRequestCallFromMutationObserver = this.makeRequestCallFromMutationObserver.bind(this)
        this.makeRequestCallFromTimer = this.makeRequestCallFromTimer.bind(this)

        if (typeof this.BrowserMutationObserver === "function") {
            this.requestFlush = this.makeRequestCallFromMutationObserver(this.flush);

        // MessageChannels are desirable because they give direct access to the HTML
        // task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
        // 11-12, and in web workers in many engines.
        // Although message channels yield to any queued rendering and IO tasks, they
        // would be better than imposing the 4ms delay of timers.
        // However, they do not work reliably in Internet Explorer or Safari.

        // Internet Explorer 10 is the only browser that has setImmediate but does
        // not have MutationObservers.
        // Although setImmediate yields to the browser's renderer, it would be
        // preferrable to falling back to setTimeout since it does not have
        // the minimum 4ms penalty.
        // Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
        // Desktop to a lesser extent) that renders both setImmediate and
        // MessageChannel useless for the purposes of ASAP.
        // https://github.com/kriskowal/q/issues/396

        // Timers are implemented universally.
        // We fall back to timers in workers in most engines, and in foreground
        // contexts in the following browsers.
        // However, note that even this simple case requires nuances to operate in a
        // broad spectrum of browsers.
        //
        // - Firefox 3-13
        // - Internet Explorer 6-9
        // - iPad Safari 4.3
        // - Lynx 2.8.7
        } else {
            this.requestFlush = this.makeRequestCallFromTimer(this.flush);
        }

        // `requestFlush` requests that the high priority event queue be flushed as
        // soon as possible.
        // This is useful to prevent an error thrown in a task from stalling the event
        // queue if the exception handled by Node.js’s
        // `process.on("uncaughtException")` or by a domain.
        this.requestFlush = this.requestFlush.bind(this)

        this.rawAsap = this.rawAsap.bind(this)
    }

    rawAsap(task) {
        if (!this.queue.length) {
            this.requestFlush();
            this.flushing = true;
        }
        // Equivalent to push, but avoids a function call.
        this.queue[this.queue.length] = task;
    }

    // The flush function processes all tasks that have been scheduled with
    // `rawAsap` unless and until one of those tasks throws an exception.
    // If a task throws an exception, `flush` ensures that its state will remain
    // consistent and will resume where it left off when called again.
    // However, `flush` does not make any arrangements to be called again if an
    // exception is thrown.
    flush() {
        while (this.index < this.queue.length) {
            var currentIndex = this.index;
            // Advance the index before calling the task. This ensures that we will
            // begin flushing on the next task the task throws an error.
            this.index = this.index + 1;
            this.queue[currentIndex].call();
            // Prevent leaking memory for long chains of recursive calls to `asap`.
            // If we call `asap` within tasks scheduled by `asap`, the queue will
            // grow, but to avoid an O(n) walk for every task we execute, we don't
            // shift tasks off the queue after they have been executed.
            // Instead, we periodically shift 1024 tasks off the queue.
            if (this.index > this.capacity) {
                // Manually shift all values starting at the index back to the
                // beginning of the queue.
                for (var scan = 0, newLength = this.queue.length - this.index; scan < newLength; scan++) {
                    this.queue[scan] = this.queue[scan + this.index];
                }
                this.queue.length -= this.index;
                this.index = 0;
            }
        }
        this.queue.length = 0;
        this.index = 0;
        this.flushing = false;
    }

    // To request a high priority event, we induce a mutation observer by toggling
    // the text of a text node between "1" and "-1".
    makeRequestCallFromMutationObserver(callback) {
        var toggle = 1;
        var observer = new this.BrowserMutationObserver(callback);
        var node = document.createTextNode("");
        observer.observe(node, {characterData: true});
        return function requestCall() {
            toggle = -toggle;
            node.data = toggle;
        };
    }

    // The message channel technique was discovered by Malte Ubl and was the
    // original foundation for this library.
    // http://www.nonblocking.io/2011/06/windownexttick.html

    // Safari 6.0.5 (at least) intermittently fails to create message ports on a
    // page's first load. Thankfully, this version of Safari supports
    // MutationObservers, so we don't need to fall back in that case.

    // function makeRequestCallFromMessageChannel(callback) {
    //     var channel = new MessageChannel();
    //     channel.port1.onmessage = callback;
    //     return function requestCall() {
    //         channel.port2.postMessage(0);
    //     };
    // }

    // For reasons explained above, we are also unable to use `setImmediate`
    // under any circumstances.
    // Even if we were, there is another bug in Internet Explorer 10.
    // It is not sufficient to assign `setImmediate` to `requestFlush` because
    // `setImmediate` must be called *by name* and therefore must be wrapped in a
    // closure.
    // Never forget.

    // function makeRequestCallFromSetImmediate(callback) {
    //     return function requestCall() {
    //         setImmediate(callback);
    //     };
    // }

    // Safari 6.0 has a problem where timers will get lost while the user is
    // scrolling. This problem does not impact ASAP because Safari 6.0 supports
    // mutation observers, so that implementation is used instead.
    // However, if we ever elect to use timers in Safari, the prevalent work-around
    // is to add a scroll event listener that calls for a flush.

    // `setTimeout` does not call the passed callback if the delay is less than
    // approximately 7 in web workers in Firefox 8 through 18, and sometimes not
    // even then.

    makeRequestCallFromTimer(callback) {
        return function requestCall() {
            // We dispatch a timeout with a specified delay of 0 for engines that
            // can reliably accommodate that request. This will usually be snapped
            // to a 4 milisecond delay, but once we're flushing, there's no delay
            // between events.
            var timeoutHandle = setTimeout(handleTimer, 0);
            // However, since this timer gets frequently dropped in Firefox
            // workers, we enlist an interval handle that will try to fire
            // an event 20 times per second until it succeeds.
            var intervalHandle = setInterval(handleTimer, 50);

            function handleTimer() {
                // Whichever timer succeeds will cancel both timers and
                // execute the callback.
                clearTimeout(timeoutHandle);
                clearInterval(intervalHandle);
                callback();
            }
        };
    }

}


// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

export default Raw
