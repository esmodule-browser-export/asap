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

        this.scope = typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : self)
        this.BrowserMutationObserver = this.scope.MutationObserver || this.scope.WebKitMutationObserver;

        this.makeRequestCallFromMutationObserver = this.makeRequestCallFromMutationObserver.bind(this)
        this.makeRequestCallFromTimer = this.makeRequestCallFromTimer.bind(this)

        if (typeof this.BrowserMutationObserver === "function") {
            this.requestFlush = this.makeRequestCallFromMutationObserver(this.flush);
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

class Asap extends Raw {

    constructor(){
        super()
        // RawTasks are recycled to reduce GC churn.
        this.freeTasks = [];
        // We queue errors to ensure they are thrown in right order (FIFO).
        // Array-as-queue is good enough here, since we are just dealing with exceptions.
        this.pendingErrors = [];
        this.throwFirstError = this.throwFirstError.bind(this)
        this.requestErrorThrow = this.makeRequestCallFromTimer(this.throwFirstError);

        this.getRawTask = this.getRawTask.bind(this)
        this.asap = this.asap.bind(this)
    }

    throwFirstError() {
        if (this.pendingErrors.length) {
            throw this.pendingErrors.shift();
        }
    }

    /**
     * Calls a task as soon as possible after returning, in its own event, with priority
     * over other events like animation, reflow, and repaint. An error thrown from an
     * event will not interrupt, nor even substantially slow down the processing of
     * other events, but will be rather postponed to a lower priority event.
     * @param {{call}} task A callable object, typically a function that takes no
     * arguments.
     */
    asap(task) {
        var rawTask;
        if (this.freeTasks.length) {
            rawTask = this.freeTasks.pop();
        } else {
            rawTask = this.getRawTask();
        }
        rawTask.task = task;
        this.rawAsap(rawTask);
    }

    // We wrap tasks with recyclable task objects.  A task object implements
    // `call`, just like a function.
    getRawTask() {
        let self = this
        let asap = self.asap

        return {
            task: null,
            // The sole purpose of wrapping the task is to catch the exception and recycle
            // the task object after its single use.
            call: function(){
                let rawTask = this
                try {
                    rawTask.task.call();
                } catch (error) {
                    if (asap.onerror) {
                        // This hook exists purely for testing purposes.
                        // Its name will be periodically randomized to break any code that
                        // depends on its existence.
                        asap.onerror(error);
                    } else {
                        // In a web browser, exceptions are not fatal. However, to avoid
                        // slowing down the queue of pending tasks, we rethrow the error in a
                        // lower priority turn.
                        self.pendingErrors.push(error);
                        self.requestErrorThrow();
                    }
                } finally {
                    rawTask.task = null;
                    self.freeTasks[self.freeTasks.length] = rawTask;
                }
            }
        }
    }

}

export default (new Asap()).asap
