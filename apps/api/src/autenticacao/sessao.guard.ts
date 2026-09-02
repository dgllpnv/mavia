import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

/**
 * Exige sessão, e não espaço.
 *
 * Existe separado do `AutorizacaoGuard` porque papel é uma propriedade **do
 * vínculo com um tenant**: perguntar "seu papel permite?" numa rota sem tenant
 * não tem resposta. As duas rotas que passam por aqui — `GET /v1/eu` e
 * `DELETE /v1/sessoes/atual` — falam do usuário, não de um espaço dele.
 *
 * A lista de rotas sem tenant é fechada e mora em `politica-acesso.ts`, ao lado
 * da matriz. Uma rota nova não entra nela por acidente: ela é conferida no
 * boot, junto da cobertura da matriz.
 */
@Injectable()
export class SessaoGuard implements CanActivate {
  canActivate(contexto: ExecutionContext): boolean {
    const req = contexto.switchToHttp().getRequest<FastifyRequest>()
    if (!req.sessao) throw new UnauthorizedException('Sessão ausente ou inválida.')
    return true
  }
}
