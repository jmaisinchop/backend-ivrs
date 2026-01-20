import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { User } from 'src/user/user.entity';

interface IRequestContext {
  user: User;
}

@Injectable()
export class RequestContext {
  private readonly als = new AsyncLocalStorage<IRequestContext>();

  run(fn: () => any) {
    return this.als.run({ user: null }, fn);
  }

  setUser(user: User) {
    const store = this.als.getStore();
    if (store) {
      store.user = user;
    }
  }

  getUser(): User | null {
    return this.als.getStore()?.user;
  }
}