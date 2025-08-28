import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { User } from 'src/user/user.entity';

interface IRequestContext {
  user: User;
}

@Injectable()
export class RequestContext {
  private readonly als = new AsyncLocalStorage<IRequestContext>();

  // Ejecuta una función dentro de un nuevo contexto
  run(fn: () => any) {
    return this.als.run({ user: null }, fn);
  }

  // Establece el usuario para el contexto actual
  setUser(user: User) {
    const store = this.als.getStore();
    if (store) {
      store.user = user;
    }
  }

  // Obtiene el usuario del contexto actual
  getUser(): User | null {
    return this.als.getStore()?.user;
  }
}