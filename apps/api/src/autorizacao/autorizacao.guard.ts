import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { pode, type Papel, type Rota, chaveDaRota, ROTAS_PUBLICAS, ROTAS_SEM_TENANT, ROTAS_DE_ADMIN } from './politica-acesso.js'

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

    const rota: Rota = {
      metodo: req.method as Rota['metodo'],
      // `routeOptions.url` é o padrão registrado (`/v1/contas/:id`), não a URL
      // concreta. Usar a URL concreta faria cada id virar uma rota diferente e
      // a matriz nunca casaria.
      caminho: req.routeOptions.url ?? '',
    }
    const chave = chaveDaRota(rota)

    // Ramo 1 · pública. Passa sem sessão, e a lista é nominal.
    //
    // Esta é a lista que existia **escrita e nunca ligada**: uma única
    // ocorrência no repositório, a própria declaração. O guard global sem ela
    // quebraria as nove rotas de credencial de uma vez.
    if (ROTAS_PUBLICAS.has(chave)) return true

    // Ramo 2 · exige sessão, dispensa espaço.
    //
    // É a semântica que o `SessaoGuard` implementava nas quatro rotas em que
    // estava aplicado. Agora vale para toda a lista, sem depender de alguém
    // lembrar do decorador.
    if (ROTAS_SEM_TENANT.has(chave)) {
      if (!req.sessao) throw new UnauthorizedException('Sessão ausente ou inválida.')
      return true
    }

    // Ramo 3 · painel de administração.
    //
    // Exige sessão e **não** exige papel: o operador não tem papel no espaço do
    // cliente, e sintetizar um faria os controladores do cliente passarem a
    // servi-lo (ADR 0024 D2). `req.autenticado` permanece nulo aqui, e é essa
    // ausência que contém a exceção.
    //
    // A resolução da concessão de administrador, a revalidação da sessão no
    // Postgres e o step-up com `tenant_alvo` entram nos tickets 04 e 06, com as
    // tabelas de que dependem. Enquanto `ROTAS_DE_ADMIN` estiver vazia este
    // ramo é inalcançável — e ele existe agora para que a rota nova não caia no
    // ramo 4, onde responderia 401 para sempre.
    if (ROTAS_DE_ADMIN.has(chave)) {
      if (!req.sessao) throw new UnauthorizedException('Sessão ausente ou inválida.')
      return true
    }

    // Ramo 4 · o padrão, e ele **nega**.
    //
    // Uma rota que não está em nenhuma das três listas chega aqui, e a
    // `verificarCoberturaDaMatriz` já derrubou o boot se ela não tiver entrada
    // na matriz. As duas coisas juntas — asserção no boot, negação em tempo de
    // execução — é o que torna "esqueci o decorador" inexpressável.
    if (!req.autenticado) {
      throw new UnauthorizedException('Sessão ausente ou inválida.')
    }

    if (!pode(rota, req.autenticado.papel)) {
      throw new ForbiddenException('Seu papel não permite esta operação.')
    }
    return true
  }
}
