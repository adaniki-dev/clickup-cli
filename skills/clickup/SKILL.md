---
name: clickup
description: Operar o ClickUp pelo CLI `clickup` (API v2) — criar, ler, listar e atualizar task, comentar, goals e key results (targets), ligar task a goal, links e dependências entre tasks, tags, custom fields, e chamada crua da API. Use quando o pedido for mexer no ClickUp pelo terminal, quando envolver goals/key results (o conector MCP do ClickUp não cobre), quando precisar de saída em JSON pra script, ou quando o usuário citar o CLI `clickup`.
---

# clickup (CLI)

`clickup <recurso> <ação> [args] [--flags]`. Texto enxuto por padrão, `--json` devolve a resposta crua da API.
`clickup --help` lista tudo; `clickup task --help` filtra por recurso.

Se `clickup` não estiver no PATH: `node <repo clickup-cli>/bin/clickup.mjs`. Sem token ele sai com código 2 e
pede `clickup setup` (interativo, é o usuário que roda).

## Antes de escrever: descobrir os ids

Nunca chuto id. O caminho é sempre este:

```sh
clickup tree                    # spaces > folders > listas, com os ids
clickup list get LIST_ID        # os status VÁLIDOS da lista (status errado a API recusa)
clickup member ls               # ids de usuário
clickup field ls LIST_ID        # custom fields: id, tipo e id das opções
clickup goal ls                 # goals; `goal get ID` mostra os key results
```

Usuário aceita id, `me`, ou um trecho do username/email (tem que bater em um só). Data aceita `AAAA-MM-DD`
(o dia, sem hora), `AAAA-MM-DDTHH:MM` ou ms.

## Tasks

```sh
clickup task create LIST_ID "Nome" --desc "markdown" --assignee me --priority high --tag bug --due 2026-11-20
clickup task create LIST_ID "Sub" --parent TASK_ID                 # subtask (mesma lista do pai)
clickup task get TASK_ID --subtasks                                # detalhe, descrição, links, campos
clickup task ls LIST_ID --status "in progress" --assignee me
clickup task ls --assignee me                                      # o workspace inteiro (aceita --list/--space)
clickup task ls LIST_ID --name checkout                            # filtra por trecho do nome
clickup task update TASK_ID --status "in review" --assignee-add bia --priority none
clickup task rm TASK_ID --yes
```

Descrição ou comentário longo: `--desc @arquivo.md` ou `--desc -` (stdin). Evita escapar markdown no shell.

`task ls` devolve uma página (100). Com mais, o rodapé manda `--page N`. A v2 não busca por texto: `--name`
varre as páginas e filtra aqui, então escopa com lista ou filtro antes de usar no workspace inteiro.

## Comentários

```sh
clickup comment add TASK_ID "texto" [--assignee U] [--notify]
clickup comment ls TASK_ID
clickup comment reply COMMENT_ID "texto"
clickup comment update COMMENT_ID "texto novo" --resolved
```

O texto vai como texto puro (`comment_text`). Markdown não vira formatação no comentário.

## Goals e key results

Goal é o objetivo; key result (target, na interface) é o que mede. Ligar task a goal é criar um key result
`automatic` com as tasks: o progresso sobe sozinho conforme elas fecham.

```sh
clickup goal create "Q4: afiliados" --due 2026-12-31 --desc "..."        # dono padrão: quem roda
clickup kr create GOAL_ID "Épico de migração" --task ID1 --task ID2       # automatic, pelas tasks
clickup kr create GOAL_ID "Sprint" --list LIST_ID                         # automatic, pela lista
clickup kr create GOAL_ID "MRR" --type currency --end 50000 --unit BRL    # manual
clickup kr add-task GOAL_ID KR_ID ID3 ID4                                 # soma tasks sem perder as atuais
clickup kr update KR_ID --current 12000 --note "fechou o mês"             # registra progresso manual
clickup goal get GOAL_ID
```

`kr update --task/--list` SUBSTITUI o conjunto; pra somar é `kr add-task`. O id do goal é o UUID de
`goal ls`, não o número da URL.

## Links, dependências, tags, campos

```sh
clickup link add TASK_ID OUTRA_ID            # relação simples
clickup dep add TASK_ID --depends-on ID      # TASK espera a outra
clickup dep add TASK_ID --blocks ID          # TASK bloqueia a outra
clickup tag add TASK_ID bug
clickup field set TASK_ID FIELD_ID VALOR     # dropdown: o id da opção (de `field ls`); número/array/objeto em JSON
```

## O que não tem comando: `api`

```sh
clickup api GET /team/TEAM_ID/time_entries --query start_date=1794000000000
clickup api POST /list/LIST_ID/task --body '{"name":"x"}'
clickup api GET /v3/workspaces/TEAM_ID/docs          # /v3 passa direto; sem versão é v2
```

Referência dos endpoints: https://developer.clickup.com/reference

## Cuidados

- Apagar (`task rm`, `goal rm`, `kr rm`, `comment rm`) é irreversível e exige `--yes`. Só passo `--yes`
  quando o usuário pediu pra apagar aquilo.
- Criar task ou comentar com `--notify`/`--assignee` notifica gente de verdade. Em lote, confirmo antes.
- Erro vem como `MÉTODO caminho: HTTP status mensagem (ECODE)`. 401 costuma ser token sem acesso àquele
  workspace; 429 é o limite de requisições do plano (espera um minuto).
- Ao citar task pro usuário, uso o nome com o link (`https://app.clickup.com/t/ID`), não o id solto.
