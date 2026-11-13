# clickup-cli

CLI do ClickUp em cima da API v2: tasks, comentários, goals e key results, links e dependências, tags,
custom fields, e uma chamada crua pro resto. Vem com uma skill pra agente (`skills/clickup`).

Zero dependência: `fetch` nativo do Node 20+.

```
clickup tree                                         spaces > folders > listas, com os ids
clickup task create LIST "Nome" --assignee me        cria task
clickup task ls --assignee me                        as minhas, no workspace inteiro
clickup comment add TASK "texto"                     comenta
clickup goal ls / goal get GOAL                      goals e os key results
clickup kr create GOAL "Épico" --task A --task B     liga tasks a um goal (key result automatic)
clickup link add A B / dep add A --depends-on B      relação e dependência entre tasks
clickup api GET /team/ID/time_entries                o que não tem comando
```

`clickup --help` lista todos os comandos; `clickup <recurso> --help` filtra.

## Instalar

```sh
npm i -g github:adaniki-dev/clickup-cli
# ou, do clone:
ln -s "$PWD/bin/clickup.mjs" ~/.local/bin/clickup
```

## Token

Uma vez por máquina:

```sh
clickup setup    # pede o token (ClickUp > avatar > Settings > Apps > API Token), valida, grava ~/.clickup.toml (0600)
```

Ordem de leitura: `CLICKUP_TOKEN`, depois `~/.clickup.toml`, depois `~/.clickup-flow.toml` (quem já usa o
[clickup-flow](https://github.com/adaniki-dev/clickup-flow) não precisa configurar nada). `CLICKUP_CONFIG`
aponta outro arquivo.

Workspace: `--team ID`, `CLICKUP_TEAM_ID` ou `team_id` no toml. Se o token enxerga um workspace só, ele é
usado sem precisar dizer.

## Convenções

- **Saída**: texto enxuto por padrão; `--json` devolve a resposta crua da API.
- **Usuário** (`--assignee`, `--owner`): id, `me`, ou trecho do username/email que bata em um membro só.
- **Data** (`--due`, `--start`): `AAAA-MM-DD` (dia, sem hora), `AAAA-MM-DDTHH:MM` ou ms.
- **Texto longo** (`--desc`, texto do comentário): `@arquivo` lê do arquivo, `-` lê do stdin.
- **Apagar** exige `--yes`.
- Flag desconhecida é erro, não é ignorada.

## Goals

Goal é o objetivo, key result (target, na interface) é o que mede. Ligar task a goal é criar um key result
`automatic`: o progresso sobe conforme as tasks fecham.

```sh
clickup goal create "Q4: afiliados" --due 2026-12-31
clickup kr create GOAL_ID "Épico de migração" --task ID1 --task ID2
clickup kr add-task GOAL_ID KR_ID ID3            # soma, sem perder as que já estão
clickup kr update KR_ID --current 12 --note "..."   # progresso de key result manual
```

## Skill

`skills/clickup/SKILL.md` ensina um agente a usar o CLI. No Claude Code:

```sh
ln -s "$PWD/skills/clickup" ~/.claude/skills/clickup
```

## Dev

```sh
npm test    # node --test: o CLI inteiro contra um ClickUp falso em HTTP local
```

## Limites

- A v2 não busca task por texto: `task ls --name` pagina e filtra no cliente.
- Comentário vai como texto puro; markdown não vira formatação.
- Sem retry em 429: o erro sobe e quem chamou decide.
