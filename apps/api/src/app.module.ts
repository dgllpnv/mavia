import { Module, type DynamicModule } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import type { Pool } from 'pg'
import type { CofreDeAcesso } from './redis/cofre-de-acesso.js'
import type { LimiteDeTentativas } from './redis/limite-de-tentativas.js'
import { COFRE, LIMITE } from './redis/tokens.js'
import { ContasController, POOL } from './contas/contas.controller.js'
import { LancamentosController } from './lancamentos/lancamentos.controller.js'
import { CartoesController } from './cartoes/cartoes.controller.js'
import { SessoesController } from './autenticacao/sessoes.controller.js'
import { CategoriasController } from './categorias/categorias.controller.js'
import { AlertasController } from './alertas/alertas.controller.js'
import { CobrancaController, WebhookController } from './cobranca/cobranca.controller.js'
import { AceitarConviteController, MembrosController } from './membros/membros.controller.js'
import { ExportacaoController } from './exportacao/exportacao.controller.js'
import { RelatoriosController } from './relatorios/relatorios.controller.js'
import { AlterarLancamentoController, RegrasController } from './classificacao/classificacao.controller.js'
import { ConciliacoesController, ImportacaoController } from './importacao/importacao.controller.js'
import { IdempotenciaInterceptor } from './idempotencia/idempotencia.interceptor.js'
import { ObjetivosController } from './objetivos/objetivos.controller.js'
import { PlanejamentosController } from './planejamentos/planejamentos.controller.js'
import { RecorrenciasController } from './recorrencias/recorrencias.controller.js'
import { ConexoesController } from './conexoes/conexoes.controller.js'
import { ClienteDoGuardiao, GUARDIAO } from './guardiao/cliente.js'
import { CadastroController } from './autenticacao/cadastro.controller.js'
import { GoogleController } from './autenticacao/google.controller.js'
import { ESTADO_OAUTH, EstadoDoOauth } from './redis/estado-do-oauth.js'
import { MENSAGEIRO, mensageiroDoAmbiente, type Mensageiro } from './mensageiro/mensageiro.js'

@Module({})
export class AppModule {
  static comPool(
    pool: Pool,
    cofre: CofreDeAcesso,
    limite: LimiteDeTentativas,
    /** O arreio de teste injeta um mensageiro que guarda em vez de enviar. */
    mensageiro?: Mensageiro,
    /**
     * O estado das tentativas de entrada pelo Google. Precisa do Redis, que
     * quem monta o processo já tem — construí-lo aqui obrigaria este módulo a
     * conhecer a conexão.
     */
    estadoDoOauth?: EstadoDoOauth,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        SessoesController,
        CadastroController,
        GoogleController,
        ContasController,
        CategoriasController,
        AlertasController,
        CobrancaController,
        WebhookController,
        MembrosController,
        AceitarConviteController,
        RelatoriosController,
        ExportacaoController,
        RegrasController,
        AlterarLancamentoController,
        ImportacaoController,
        ConciliacoesController,
        ObjetivosController,
        PlanejamentosController,
        RecorrenciasController,
        ConexoesController,
        LancamentosController,
        CartoesController,
      ],
      providers: [
        { provide: POOL, useValue: pool },
        { provide: COFRE, useValue: cofre },
        { provide: LIMITE, useValue: limite },
        // Uma instância por processo. Ela não guarda chave nenhuma: o estado
        // que importa vive no processo do guardião, do outro lado do socket.
        { provide: GUARDIAO, useValue: new ClienteDoGuardiao() },
        { provide: MENSAGEIRO, useValue: mensageiro ?? mensageiroDoAmbiente() },
        { provide: ESTADO_OAUTH, useValue: estadoDoOauth },
        // Global de propósito: idempotência escrita rota a rota é idempotência
        // que falta na rota nova. Aqui é propriedade do transporte, e vale para
        // qualquer mutação que traga `Idempotency-Key` — inclusive as que ainda
        // não existem.
        { provide: APP_INTERCEPTOR, useClass: IdempotenciaInterceptor },
      ],
    }
  }
}
