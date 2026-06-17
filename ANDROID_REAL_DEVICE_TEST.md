# Teste Em Aparelho Android Real - Pife Duelo

Este roteiro deve ser executado em um celular Android fisico. Ele nao substitui testes automatizados, mas valida toque, arraste, escala real e sensacao de jogo.

## Preparacao

1. Rodar o projeto em modo desenvolvimento.
2. Abrir o endereco local no navegador do Android pela mesma rede.
3. Testar em orientacao vertical.
4. Desativar zoom manual do navegador, se estiver interferindo.

## Checklist Visual

- A mesa ocupa bem a tela vertical.
- Nao existe barra horizontal.
- Nenhuma carta sai da tela.
- Cartas do jogador ficam em arco e nao ficam cortadas.
- Cartas do oponente ficam dentro da area superior.
- HUD do jogador e do oponente nao corta texto.
- Timer nao cobre cartas.
- Botao BATER nao cobre cartas.
- Monte e descarte ficam clicaveis no centro.
- Verso das cartas mostra PIFE DUELO.

## Checklist De Toque

- Tocar em uma carta seleciona a carta.
- A carta selecionada recebe destaque visual suave.
- Tocar novamente na mesma carta remove a selecao.
- O botao Auto ativa organizacao automatica.
- O botao Manual ativa organizacao manual.
- No modo manual, tocar nas setas muda a carta selecionada de posicao.

## Checklist De Arraste

- Comprar carta no monte.
- Confirmar que a mao fica com 10 cartas.
- Arrastar uma carta ate o descarte.
- Confirmar que a carta entra no descarte.
- Confirmar que a mao volta para 9 cartas apos o bot jogar.
- Repetir usando dedo polegar e dedo indicador.
- Repetir em aparelho com tela menor, se disponivel.

## Fluxo Alternativo Para Android

Se o arraste estiver dificil:

1. Comprar carta.
2. Tocar na carta que deseja descartar.
3. Tocar na area de descarte.
4. Confirmar que o descarte acontece.

Esse fluxo foi mantido como apoio para telas pequenas e navegadores Android.

## Teste De BATER

Abrir o modo audit com mao vencedora:

```txt
http://127.0.0.1:5173/?audit=winning-player
```

Validar:

- Botao BATER aparece ativo.
- Botao pulsa discretamente.
- Ao tocar em BATER, aparece animacao de impacto.
- Cartas vencedoras brilham.
- Modal de Vitoria aparece.

## Teste De Mao Invalida

Abrir:

```txt
http://127.0.0.1:5173/?audit=invalid
```

Validar:

- Botao BATER aparece apagado.
- Botao BATER nao permite acao.
- Compra e descarte continuam funcionando.

## Teste De Reciclagem

Abrir:

```txt
http://127.0.0.1:5173/?audit=recycle
```

Validar:

- Monte inicia vazio.
- Ao comprar, descarte recicla para o monte.
- Ultima carta do descarte permanece visivel.
- Jogo continua sem travar.

## Resultado Esperado

O jogo deve continuar fluido, legivel e jogavel com toque real, sem depender de mouse.
