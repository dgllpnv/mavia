'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { chamar, ErroDaApi } from '../../../api/cliente'
import { Cartao, Vazio } from '../../../componentes/cartao'
import { Modal } from '../../../componentes/modal'
import { useSessao } from '../../../componentes/provedores'

/**
 * Quem tem acesso ao espaço.
 *
 * ## O convite é um link, e o link aparece uma vez
 *
 * O envio por e-mail depende do mailer (P-3). Em vez de prender o
 * compartilhamento a ele, o proprietário recebe o link na tela e o entrega pelo
 * meio que quiser — WhatsApp, mensagem, papel.
 *
 * A tela diz **explicitamente** que o link não volta a aparecer. Um segredo que
 * a interface mostra como se pudesse ser reaberto depois é um segredo que a
 * pessoa fecha sem copiar.
 *
 * ## A senha nas operações de risco
 *
 * Mudar papel e remover alguém pedem a senha no ato. Não é fricção decorativa:
 * são as duas operações pelas quais um navegador deixado aberto viraria uma
 * conta perdida.
 */
export default function Membros() {
  const { espaco, eu } = useSessao()
  const fila = useQueryClient()
  const [convidando, setConvidando] = useState(false)
  const [linkNovo, setLinkNovo] = useState<string | null>(null)
  const [emFoco, setEmFoco] = useState<Membro | null>(null)

  const membros = useQuery({
    queryKey: ['membros', espaco?.id],
    enabled: espaco !== null,
    queryFn: () => chamar<{ itens: Membro[] }>('/membros', { tenantId: espaco!.id }),
  })

  const convites = useQuery({
    queryKey: ['convites', espaco?.id],
    enabled: espaco?.papel === 'proprietario',
    queryFn: () => chamar<{ itens: Convite[] }>('/membros/convites', { tenantId: espaco!.id }),
  })

  const revogar = useMutation({
    mutationFn: (id: string) =>
      chamar(`/membros/convites/${id}`, { metodo: 'DELETE', tenantId: espaco!.id }),
    onSuccess: () => void fila.invalidateQueries({ queryKey: ['convites'] }),
  })

  const ehDono = espaco?.papel === 'proprietario'
  const ativos = (membros.data?.itens ?? []).filter((m) => m.removidoEm === null)
  const sairam = (membros.data?.itens ?? []).filter((m) => m.removidoEm !== null)

  return (
    <>
      <div className="flex flex-wrap items-center gap-16">
        <h1 className="text-2 font-semibold">Pessoas em {espaco?.nome}</h1>
        {ehDono && (
          <button
            className="botao botao--primario ml-auto"
            onClick={() => {
              setLinkNovo(null)
              setConvidando(true)
            }}
          >
            + convidar
          </button>
        )}
      </div>

      <Cartao className="mt-24" semPadding>
        {ativos.map((m) => (
          <div key={m.usuarioId} className="linha grid-cols-[1fr_auto] items-center">
            <span className="min-w-0">
              <span className="block truncate text-1">
                {m.nome}
                {m.usuarioId === eu?.usuario.id && (
                  <span className="ml-8 text-sm text-ink-3">você</span>
                )}
              </span>
              <span className="mt-2 block text-sm text-ink-3">
                {PAPEL[m.papel] ?? m.papel}
                {/* O e-mail só existe na resposta para o proprietário: a
                    matriz separa `ler` de `ler_contato`, e a ausência aqui é a
                    regra funcionando, não um campo esquecido. */}
                {m.email && ` · ${m.email}`}
              </span>
            </span>

            {ehDono && m.usuarioId !== eu?.usuario.id && (
              <button className="botao botao--discreto" onClick={() => setEmFoco(m)}>
                alterar
              </button>
            )}
            {m.usuarioId === eu?.usuario.id && !ehDono && (
              <button className="botao botao--discreto text-despesa" onClick={() => setEmFoco(m)}>
                sair do espaço
              </button>
            )}
          </div>
        ))}
      </Cartao>

      {ehDono && (convites.data?.itens.length ?? 0) > 0 && (
        <Cartao titulo="Convites pendentes" className="mt-24" semPadding>
          {convites.data!.itens.map((c) => (
            <div key={c.id} className="linha grid-cols-[1fr_auto] items-center">
              <span className="min-w-0">
                <span className="block truncate text-1">{c.email}</span>
                <span className="mt-2 block text-sm text-ink-3">
                  como {PAPEL[c.papel] ?? c.papel} · expira em{' '}
                  {new Date(c.expiraEm).toLocaleDateString('pt-BR')}
                </span>
              </span>
              <button className="botao botao--discreto" onClick={() => revogar.mutate(c.id)}>
                revogar
              </button>
            </div>
          ))}
        </Cartao>
      )}

      {sairam.length > 0 && (
        <Cartao titulo="Já não têm acesso" className="mt-24" semPadding>
          {sairam.map((m) => (
            <div key={m.usuarioId} className="linha">
              <span className="text-1 text-ink-3">{m.nome}</span>
            </div>
          ))}
          <p className="px-20 py-12 text-sm text-ink-3">
            Continuam aqui porque os lançamentos que fizeram continuam sendo
            deles. O acesso acabou; o histórico não some.
          </p>
        </Cartao>
      )}

      {!ehDono && (
        <p className="mt-24 max-w-[70ch] text-sm text-ink-3">
          Só o proprietário do espaço convida e altera papéis. Você pode sair
          quando quiser.
        </p>
      )}

      {convidando && (
        <Convidar
          tenantId={espaco!.id}
          aoConvidar={(token) => {
            setLinkNovo(token)
            setConvidando(false)
            void fila.invalidateQueries({ queryKey: ['convites'] })
          }}
          aoFechar={() => setConvidando(false)}
        />
      )}

      {linkNovo && (
        <Modal titulo="Convite criado" largura={520} aoFechar={() => setLinkNovo(null)}>
          <p className="mt-16 text-corpo text-ink-2">
            Entregue este link à pessoa. Ele funciona <strong>uma vez</strong>,
            só para o e-mail que você informou, e expira em sete dias.
          </p>
          <p className="mt-16 rounded-2 border border-line bg-surface-2 p-12 font-numero text-sm break-all">
            {`${window.location.origin}/convite/${linkNovo}`}
          </p>
          <p className="mt-12 text-sm text-atencao">
            Copie agora: este link não volta a aparecer.
          </p>
          <div className="mt-24 flex justify-end gap-12 border-t border-line pt-16">
            <button
              className="botao botao--primario"
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${window.location.origin}/convite/${linkNovo}`,
                )
              }}
            >
              copiar link
            </button>
            <button className="botao" onClick={() => setLinkNovo(null)}>
              fechar
            </button>
          </div>
        </Modal>
      )}

      {emFoco && (
        <Alterar
          tenantId={espaco!.id}
          membro={emFoco}
          souEu={emFoco.usuarioId === eu?.usuario.id}
          aoConcluir={() => {
            setEmFoco(null)
            void fila.invalidateQueries({ queryKey: ['membros'] })
          }}
          aoFechar={() => setEmFoco(null)}
        />
      )}
    </>
  )
}

function Convidar({
  tenantId,
  aoConvidar,
  aoFechar,
}: {
  tenantId: string
  aoConvidar(token: string): void
  aoFechar(): void
}) {
  const [email, setEmail] = useState('')
  const [papel, setPapel] = useState<'membro' | 'visualizador'>('membro')
  const [erro, setErro] = useState<string | null>(null)

  const convidar = useMutation({
    mutationFn: () =>
      chamar<{ token: string }>('/membros/convites', {
        metodo: 'POST',
        tenantId,
        corpo: { email: email.trim(), papel },
      }),
    onSuccess: (r) => aoConvidar(r.token),
    onError: (e) =>
      setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível criar o convite.'),
  })

  return (
    <Modal
      titulo="Convidar alguém"
      subtitulo="O link vale só para este e-mail, e expira em sete dias."
      largura={460}
      aoFechar={aoFechar}
    >
      <div className="mt-24 flex flex-col gap-20">
        <label className="flex flex-col gap-6">
          <span className="rotulo">E-mail</span>
          <input
            className="campo"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </label>

        <label className="flex flex-col gap-6">
          <span className="rotulo">Pode</span>
          <select
            className="campo"
            value={papel}
            onChange={(e) => setPapel(e.target.value as typeof papel)}
          >
            <option value="membro">lançar e consultar</option>
            <option value="visualizador">só consultar</option>
          </select>
        </label>

        <p className="text-sm text-ink-3">
          Proprietário não se convida: promover alguém é outra operação, e ela
          pede a sua senha.
        </p>

        {erro && (
          <p role="alert" className="text-corpo text-despesa">
            {erro}
          </p>
        )}

        <div className="flex justify-end gap-12 border-t border-line pt-16">
          <button className="botao" onClick={aoFechar}>
            cancelar
          </button>
          <button
            className="botao botao--primario"
            onClick={() => {
              setErro(null)
              convidar.mutate()
            }}
            disabled={email.trim() === '' || convidar.isPending}
          >
            {convidar.isPending ? 'criando…' : 'criar convite'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Alterar({
  tenantId,
  membro,
  souEu,
  aoConcluir,
  aoFechar,
}: {
  tenantId: string
  membro: Membro
  souEu: boolean
  aoConcluir(): void
  aoFechar(): void
}) {
  const [papel, setPapel] = useState(membro.papel)
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const mudar = useMutation({
    mutationFn: () =>
      chamar(`/membros/${membro.usuarioId}`, {
        metodo: 'PATCH',
        tenantId,
        corpo: { papel, senha },
      }),
    onSuccess: aoConcluir,
    onError: (e) => setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível alterar.'),
  })

  const remover = useMutation({
    mutationFn: () =>
      chamar(`/membros/${membro.usuarioId}`, {
        metodo: 'DELETE',
        tenantId,
        ...(souEu ? {} : { corpo: { senha } }),
      }),
    onSuccess: aoConcluir,
    onError: (e) => setErro(e instanceof ErroDaApi ? e.message : 'Não foi possível remover.'),
  })

  return (
    <Modal
      titulo={souEu ? 'Sair do espaço' : membro.nome}
      largura={460}
      aoFechar={aoFechar}
    >
      {souEu ? (
        <p className="mt-16 max-w-[52ch] text-corpo text-ink-2">
          Você perde o acesso a este espaço. Os lançamentos que você fez
          continuam lá — eles são do espaço, não seus.
        </p>
      ) : (
        <>
          <label className="mt-24 flex flex-col gap-6">
            <span className="rotulo">Papel</span>
            <select className="campo" value={papel} onChange={(e) => setPapel(e.target.value)}>
              <option value="proprietario">proprietário — tudo, inclusive cobrança</option>
              <option value="membro">membro — lança e consulta</option>
              <option value="visualizador">visualizador — só consulta</option>
            </select>
          </label>

          <label className="mt-16 flex flex-col gap-6">
            <span className="rotulo">Sua senha</span>
            <input
              className="campo"
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
            />
          </label>

          <p className="mt-12 max-w-[52ch] text-sm text-ink-3">
            Mudar papel e remover alguém pedem a sua senha no ato. São as duas
            operações pelas quais um navegador deixado aberto viraria uma conta
            perdida.
          </p>
        </>
      )}

      {erro && (
        <p role="alert" className="mt-16 text-corpo text-despesa">
          {erro}
        </p>
      )}

      <div className="mt-24 flex items-center gap-12 border-t border-line pt-16">
        <button
          className="botao botao--discreto text-despesa"
          onClick={() => {
            setErro(null)
            remover.mutate()
          }}
          disabled={remover.isPending || (!souEu && senha === '')}
        >
          {souEu ? 'sair do espaço' : 'remover do espaço'}
        </button>

        <button className="botao ml-auto" onClick={aoFechar}>
          cancelar
        </button>

        {!souEu && (
          <button
            className="botao botao--primario"
            onClick={() => {
              setErro(null)
              mudar.mutate()
            }}
            disabled={mudar.isPending || senha === '' || papel === membro.papel}
          >
            {mudar.isPending ? 'salvando…' : 'salvar papel'}
          </button>
        )}
      </div>
    </Modal>
  )
}

const PAPEL: Record<string, string> = {
  proprietario: 'proprietário',
  membro: 'membro',
  visualizador: 'visualizador',
}

interface Membro {
  readonly usuarioId: string
  readonly nome: string
  readonly papel: string
  readonly email: string | null
  readonly removidoEm: string | null
}

interface Convite {
  readonly id: string
  readonly email: string
  readonly papel: string
  readonly expiraEm: string
}
