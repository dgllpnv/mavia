# `@mavia/parser`

O leitor de arquivo enviado por usuário — OFX e CSV.

## Por que é um pacote separado

Porque é a **superfície mais hostil do produto**, e o isolamento precisa ser
visível na árvore de dependências, não só na intenção.

Este pacote **não depende de nada**. Nem do domínio, nem dos contratos, nem de
uma biblioteca de parsing. Ele não faz rede, não lê variável de ambiente, não
toca em banco e não conhece `Money` — devolve centavos como `bigint` cru e
strings, e quem monta o valor com moeda é o chamador.

Um `import` novo aqui é uma decisão que precisa ser defendida, e a ausência de
`dependencies` no `package.json` é o que força a defesa.

## O que ele garante

- **Nenhum ponto flutuante toca dinheiro.** `parseFloat('1234.56') * 100` dá
  `123455.99999999999`; aqui a string vira dois `bigint` e o resultado é exato
  por construção. Há propriedade cobrindo a faixa em que o `double` já perdeu
  precisão.
- **Recusa em vez de adivinhar.** Três casas decimais, texto no lugar de número,
  data impossível — tudo vira erro nomeado, com o valor bruto junto. Um parser
  que adivinha produz um extrato plausível e errado, que é pior do que uma
  importação que falhou.
- **Nada é descartado em silêncio.** Uma linha ilegível vira uma linha de erro
  no resultado, com o número da linha. A importação segue, e a tela mostra o que
  não entrou.

## O que ainda não é (P-12)

O `docs/arquitetura/sistema.md` §2.6 exige que o parsing execute num **processo
filho descartável**, sem rede, sem segredo e com filesystem somente-leitura.
Este pacote foi escrito para caber nesse processo — puro, sem dependências, sem
I/O — mas o isolamento em si é propriedade do container, e ainda não existe.
