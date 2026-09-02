import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { pode, type Papel, type Rota } from './politica-acesso.js'

/**
 * O guard que aplica a matriz.
 *
 * Ele não decide nada: apenas pergunta à matriz. Toda a política vive em
 * `politica-acesso.ts`, que é dado e se lê de uma vez — em vez de espalhada
 * por decoradores em cada controlador, onde ninguém consegue auditá-la.
 */

export interface Autenticado {
  readonly usuarioId: string
  readonly tenantId: string
  readonly papel: Papel
}

declare module 'fastify' {
  interface FastifyRequest {
    autenticado?: Autenticado
  }
}

@Injectable()
export class AutorizacaoGuard implements CanActivate {
  canActivate(contexto: ExecutionContext): boolean {
    const req = contexto.switchToHttp().getRequest<FastifyRequest>()

    if (!req.autenticado) {
      throw new UnauthorizedException('Sessão ausente ou inválida.')
    }

    const rota: Rota = {
      metodo: req.method as Rota['metodo'],
      // `routeOptions.url` é o padrão registrado (`/v1/contas/:id`), não a URL
      // concreta. Usar a URL concreta faria cada id virar uma rota diferente e
      // a matriz nunca casaria.
      caminho: req.routeOptions.url ?? '',
    }

    if (!pode(rota, req.autenticado.papel)) {
      throw new ForbiddenException('Seu papel não permite esta operação.')
    }
    return true
  }
}
