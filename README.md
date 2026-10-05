# reqresp

Cliente HTTP simplificado, no estilo do Insomnia, em Python. A interface principal abre no navegador (FastAPI + HTML/JS, sem etapa de build) e há também uma versão para o terminal ([Textual](https://textual.textualize.io)). As requisições ## Uso

```bash
.venv/bin/reqresp              # abre a interface no navegador (http://127.0.0.1:8765)
.venv/bin/reqresp --port 9000  # outra porta
.venv/bin/reqresp-tui          # versão para o terminal
```

O servidor só escuta em `127.0.0.1`. Para sair, aperte `ctrl+c` no terminal.

### Projetos e variáveis

- **Projetos**: escolha o projeto no topo. O menu `⋯` cria, renomeia, exporta, importa e exclui projetos.
- **Salvar requisições**: o botão **Salvar** (`⌘S` / `Ctrl+S`) guarda a requisição atual no projeto.
  - Se ela já estava salva, a versão salva é atualizada; um "●" laranja indica alterações ainda não salvas.
  - Na barra lateral dá para renomear (✎), duplicar (⧉), excluir (✕) e arrastar para reordenar.
- **Variáveis**: use `{{nome}}` na URL, params, headers, body e auth.
  - O botão **{{ }} Variáveis** abre o editor. Cada projeto tem seus ambientes (dev, prod…), e existem as **globais**, que valem em todos os projetos.
  - Variáveis do ambiente ativo têm prioridade sobre as globais. Uma variável pode usar outra (`base` = `{{host}}/api`).
  - A linha abaixo da URL mostra como ela vai ficar. Variáveis não definidas aparecem em vermelho e também geram um aviso na resposta.
- **Variáveis secretas** (🔒): aparecem mascaradas na tela e vão vazias ao exportar o projeto.
  - O histórico sempre guarda a requisição com os `{{placeholders}}`, nunca os valores.
- **Insomnia**: o menu `⋯` exporta para o Insomnia em **YAML v5** (formato atual) ou **JSON v4** (legado, também aceito por outras ferramentas). **Importar…** aceita arquivos do reqresp e do Insomnia (v4 e v5) e detecta o formato sozinho.
  - Pastas viram nomes como `Pasta / Sub / Requisição`, e headers e auth da pasta são copiados para as requisições.
  - O Base Environment é mesclado em cada sub-ambiente, e `{{ _.var }}` vira `{{var}}` (e o contrário ao exportar).
  - O que o reqresp não suporta (multipart, OAuth 2, WebSocket/gRPC, tags `{% … %}`) é listado num aviso ao final da importação.
- **Onde fica salvo**:
  - projetos: `~/.reqresp/projects/<id>.json`
  - variáveis globais: `~/.reqresp/globals.json`
  - para usar outra pasta: `reqresp --data-dir caminho/`

### Interface web

- **URL e Params sincronizados**: colar uma URL com `?a=1&b=2` preenche a aba Params, e editar os params atualiza a URL. Desmarque um param para deixá-lo de fora sem apagar.
- **Headers**: comece a digitar na última linha vazia e outra linha aparece embaixo.
- **Body**: Nenhum, JSON ou Texto. O JSON é validado enquanto você digita e pode ser formatado com um clique. Ao escolher POST, PUT ou PATCH, o body muda para JSON automaticamente.
- **Auth**: Bearer Token ou Basic Auth.
- **Resposta**: status colorido, tempo e tamanho. O JSON aparece formatado e com cores, com opção de ver o texto bruto, e o botão Copiar copia o corpo.
- **Gráfico** (estilo [JSON Crack](https://jsoncrack.com)): mostra o JSON da resposta como um diagrama de cartões ligados pelas chaves.
  - Arraste para mover, use a roda do mouse ou o pinch para dar zoom, e `▸`/`▾` para recolher ou expandir ramos.
  - Clique num cartão para ver e copiar o caminho JSON dele (por exemplo `$[5].address`).
  - Tem os botões Ajustar, Expandir/Recolher tudo e Tela cheia (`Esc` sai).
  - Em respostas grandes, o diagrama mostra uma parte por vez, com cartões "+N mais" para carregar o restante.
- **Busca na resposta**: o campo acima do body (`⌘F` / `Ctrl+F`) destaca as ocorrências no Body (Formatado, Bruto ou Gráfico) e filtra as linhas da aba Headers.
  - No Gráfico, procura em chaves, valores e nomes das arestas, inclusive em ramos recolhidos. Ir para uma ocorrência expande o caminho até ela e centraliza o cartão. Em listas grandes, aparece só a página de 100 itens que a contém, com "↑ N anteriores" e "+N mais".
  - Em tela cheia, a busca vai junto. O primeiro `Esc` limpa a busca e o segundo sai da tela cheia.
  - `Enter` / `Shift+Enter` (ou ↓ / ↑) passam pelas ocorrências, e `Esc` limpa. Não diferencia maiúsculas e mostra no máximo 1000 destaques.
  - Um segundo `⌘F` com o campo já focado abre a busca do navegador.
- **Histórico**: as últimas 50 requisições, com filtro. Clique numa delas para reabrir.
- **Tema claro/escuro**: segue o sistema, e o botão no topo alterna.
- **Rascunho**: a requisição em edição continua lá depois de recarregar a página.
- **Atalho**: `⌘ Enter` (ou `Ctrl Enter`) envia de qualquer lugar.

### Versão terminal

| Atalho | Ação |
|---|---|
| `ctrl+s` / `Enter` na URL | Enviar a requisição |
| `ctrl+b` | Mostrar ou ocultar o histórico |
| `ctrl+l` | Limpar o histórico |
| `ctrl+q` | Sair |

As duas versões usam o mesmo histórico (`~/.reqresp/history.json`).

ken ou Basic Auth.
- **Histórico**: as últimas 50 requisições ficam salvas em `~/.reqresp/history.json`. Selecione uma para recarregá-la.

## Testes

```bash
.venv/bin/pytest                      # backend e TUI
node --test 'tests/js/*.test.mjs'     # montagem e layout do gráfico
```
