export class TaskQueue<T> {
  private tasks: { value: T; resolve: (v: any) => void; reject: (e: any) => void }[] = []
  private waiters: ((task: { value: T; resolve: (v: any) => void; reject: (e: any) => void }) => void)[] = []
  enqueue(value: T) {
    return new Promise((resolve, reject) => {
      const task = { value, resolve, reject }
      const waiter = this.waiters.shift()
      if (waiter) waiter(task)
      else this.tasks.push(task)
    })
  }
  next() {
    return new Promise<{ value: T; resolve: (v: any) => void; reject: (e: any) => void }>(resolve => {
      const t = this.tasks.shift()
      if (t) resolve(t)
      else this.waiters.push(resolve)
    })
  }
}


