/**
 * Prevents one UI action from being processed twice while it is running and,
 * optionally, after it has completed successfully (for one modal opportunity).
 * Create a new guard when the next legitimate opportunity begins.
 */
export function createActionGuard(action, { once = true } = {}) {
  let processing = false;
  let completed = false;

  return function guardedAction(...args) {
    if (processing || (once && completed)) return undefined;

    processing = true;
    let result;
    try {
      result = action.apply(this, args);
    } catch (error) {
      processing = false;
      throw error;
    }

    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then(value => {
        completed = value !== false;
        return value;
      }).finally(() => {
        processing = false;
      });
    }

    completed = result !== false;
    processing = false;
    return result;
  };
}
