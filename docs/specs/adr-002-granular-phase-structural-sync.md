# [ADR-002] Sincronização Granular de Operações Estruturais e Metadados de Fases

## Status
**Aceito & Implementado** (Novembro/2026) — Resolução da **Issue #5**

---

## Contexto & Problema

Mesmo após o [ADR-001](./adr-001-granular-sync-neon-adapter.md) isolar edições de questões em `PUT /api/phases/[id]`, todas as operações estruturais na lista de fases do Modo Editor (`/editor`) — criar fase, excluir fase, reordenar fases e importar pacotes JSON — ainda utilizavam o fluxo monolítico (`POST /api/phases` → `syncPhasesToDb`), gerando dois problemas críticos:

1. **Payload e escrita desproporcionais:** criar uma fase vazia ou reordenar duas fases reenviava todo o currículo pela rede e executava `1 + 2P + Q` queries em uma única transação interativa no Neon PostgreSQL.
2. **Exclusão acidental em cascata (`onDelete: Cascade`):** `syncPhasesToDb` executava `tx.phase.deleteMany({ where: { id: { notIn: phaseIds } } })`. Qualquer aba defasada apagava fases criadas por outro professor, destruindo em cascata suas questões e todo o histórico de `Submission` dos alunos no Analytics.

Além disso, alterações de metadados da fase (`titulo`, `icone`, `oculta`) ainda disparavam `PUT /api/phases/[id]` a cada tecla digitada, reescrevendo todas as questões da fase.

---

## Decisões Arquiteturais (Zero-DDL)

Nenhuma alteração no `prisma/schema.prisma` foi necessária.

1. **Eliminação do Sync Monolítico Destrutivo:**
   - Remoção definitiva de `syncPhasesToDb` (`src/lib/db.ts`) e `savePhasesApi` (`src/lib/api.ts`).
   - Centralização da checagem RBAC de docentes em `isTeacherRequest()` (`src/lib/apiAuth.ts`).
2. **Endpoints REST Granulares por Operação:**
   - **`POST /api/phases` (`createPhaseInDb`):** cria 1 única fase usando `aggregate({ _max: { order: true } })` + `phase.create` (`201 Created`, `409` em duplicidade).
   - **`PATCH /api/phases/[id]` (`updatePhaseMetadataInDb`):** atualiza apenas `title` e `icon` (`:oculta`) sem tocar em `Question`. No Editor, alterações de título usam debounce de 500 ms com *flush* no `onBlur`/troca de fase; ícone e visibilidade enviam imediatamente.
   - **`GET /api/phases/[id]/impact` (`getPhaseDeletionImpact`):** consulta Zero-DDL de questões, submissões e alunos distintos afetados; o modal de exclusão só abre após carregar o impacto real.
   - **`DELETE /api/phases/[id]` (`deletePhaseFromDb`):** valida no servidor que resta mais de 1 fase (`409 Conflict` caso contrário), remove apenas o ID alvo e compacta ordens posteriores (`decrement: 1`).
   - **`PATCH /api/phases/reorder` (`reorderPhasesInDb`):** recebe apenas `{ orderedIds }`, aplica *merge* seguro preservando fases criadas externamente (`hasExternalChanges`) e atualiza somente `order` em 1 único `UPDATE ... FROM (VALUES ...)` parametrizado via `$executeRaw`.
   - **`POST /api/phases/import` (`importPhasesToDb`):** recebe apenas `importedPhases` e insere em lote via `phase.createMany` + `question.createMany`. No cliente, `chunkPhasesForImport` particiona pacotes grandes (> 100 questões ou > 1 MB) mantendo cada fase atômica e exibindo progresso.
3. **Resiliência Multi-Professor no Editor (`/editor`):**
   - Trava de ações estruturais durante a hidratação inicial (`syncStatus === 'hydrating'`).
   - Re-sincronização automática ao retomar o foco da aba (`visibilitychange`/`window.focus` com cooldown de 5s e guarda de modais/edições pendentes) e pós-reorder quando `hasExternalChanges === true`.
   - Correção do falso positivo de sucesso na importação quando o servidor retorna erro.
