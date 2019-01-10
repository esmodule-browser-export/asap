// rawAsap provides everything we need except exception management.
import Raw from "./raw"

class Asap extends Raw {

    constructor(){
        super()
        // RawTasks are recycled to reduce GC churn.
        this.freeTasks = [];
        // We queue errors to ensure they are thrown in right order (FIFO).
        // Array-as-queue is good enough here, since we are just dealing with exceptions.
        this.pendingErrors = [];
        this.throwFirstError = this.throwFirstError.bind(this)
        this.requestErrorThrow = this.rawAsap.makeRequestCallFromTimer(this.throwFirstError);

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
