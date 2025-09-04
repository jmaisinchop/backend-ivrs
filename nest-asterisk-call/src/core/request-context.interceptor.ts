import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContext } from './request-context.service';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly requestContext: RequestContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // El interceptor envuelve el resto de la ejecución en el contexto.
    // Para cuando este código se ejecute, el AuthGuard ya habrá procesado la petición.
    return this.requestContext.run(() => {
      if (request.user) {
        this.requestContext.setUser(request.user);
      }
      return next.handle();
    });
  }
}