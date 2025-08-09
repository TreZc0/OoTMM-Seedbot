class Gate {
  constructor(max) {
    this.max = Math.max(1, max);
    this.current = 0;
    this.waiters = [];
  }

  tryAcquire() {
    if (this.current < this.max) {
      this.current += 1;
      return () => this.release();
    }
    return null;
  }

  acquire() {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (this.current < this.max) {
          this.current += 1;
          resolve(() => this.release());
          return true;
        }
        return false;
      };
      if (!tryAcquire()) {
        this.waiters.push(tryAcquire);
      }
    });
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next && next()) {
        break;
      }
    }
  }
}

module.exports = { Gate };
