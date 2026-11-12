# Visual Flow Diff — selection and archived comparison projects

Create a **Visual Flow Diff** webapp from this plugin and start its Python backend.
Install the complete plugin, including `python-lib/visualflowdiff/`, `resource/`,
and the webapp files. Restart the Python backend after updating it.

In the webapp settings, select **Comparison registry dataset**: a dedicated
Snowflake **table dataset** in the hosting project. No backend filesystem path or
comparison-project folder parameter is required. Generated projects use DSS's
default destination.

Create an empty Snowflake table dataset in DSS and select it in the webapp
settings. No manual column definitions or SQL script are required. On the first
**Confirm selection**, the backend creates the underlying table if it is missing,
adds any missing registry columns to an existing empty table, and writes the DSS
dataset schema automatically. A later retry resumes partial initialization.
Existing registry tables are reused, including when their DSS schema needs to be
synchronized. A populated table missing registry columns is rejected without
schema changes. Extra columns on an empty table are preserved, not removed.

Choose your own database, schema, and table name through the dataset's settings.
The webapp resolves the actual table from its location metadata, including
project variables and quoted names. SQL-query datasets, files, and other database
types are currently unsupported. [registry-schema.sql](registry-schema.sql) is
an optional reference for environments that provision tables separately.

The backend identity needs permission to update the dataset's DSS schema.
Its Snowflake connection role needs `CREATE TABLE` in the destination schema if
the table does not exist, and table ownership/ALTER rights if columns must be
added. Normal registry use requires `SELECT`, `INSERT`, and `UPDATE`, plus the
usual database/schema/warehouse access. Missing setup permissions produce an
actionable error before any project is duplicated. Initialization never drops,
truncates, replaces, or rebuilds an existing table. Use a dedicated dataset with
no Flow recipe rebuilding it.

Each row describes one instance/source project/full commit SHA. Readable columns
include the generated project key, branch, preparation stage, verified HEAD, and
Unix epoch timestamps. `RECORD_JSON` preserves the complete recovery record,
including the duplication ownership nonce and reserved name, and is authoritative
when recovering. No dataset contents, credentials, or full Git repositories are
stored in it.

This version assumes **one active preparation writer per registry dataset**.
A standard Snowflake table is sufficient; hybrid tables and enforced keys are
not required. There are no filesystem locks, database locks, leases, or concurrent
writer guarantees. The backend reuses identical active retries and rejects a
second different preparation until the active job finishes, including when a
user returns to selection. Different webapp instances must use separate registry
tables if they can prepare at the same time.

The backend uses the DSS viewer's browser ticket for every project and commit
request. The webapp run-as user needs DSS's **Impersonation in webapps** permission
for the intended viewers. Authentication failures never fall back to the run-as
user's access. See [Dataiku webapp security](https://doc.dataiku.com/dss/latest/webapps/security.html).
Viewers also need source project administration/export rights and permission to
create projects in the destination folder. DSS enforces these permissions for
the actual project API calls; the backend does not elevate project operations
to the run-as user. Registry dataset access uses the backend identity.

- **Within one project:** choose a baseline project and two different commits.
  The comparison project follows the baseline automatically.
- **Across project branches:** choose a baseline project, then one of its branch
  projects and a commit on each side. The comparison dropdown includes only
  accessible projects whose DSS Git `originProjectKey` matches the baseline.
  Unrelated projects, the baseline itself, and indirect descendants are excluded.
  Changing the baseline clears the comparison selection and reloads its branches.
  If some relationships cannot be checked, only verified branches are shown,
  with a notice and a retry action. Empty branch lists are shown explicitly.
- Archived projects are excluded from both project and branch dropdowns, including
  generated comparison copies. Flow loading and cleanup can still access these
  copies directly.
- The current DSS project is preselected when accessible and not archived. Commits are loaded
  newest first, 50 at a time. Commits whose message contains `Initialize gitignore`
  are hidden. Selecting a project automatically selects its newest remaining commit
  for the baseline. Within one project, **Compare with** defaults to the second
  eligible commit, or stays unselected if only one is available. Across branches,
  it defaults to the newest eligible commit in the selected branch project.
  Available Git tags appear in bold green beneath each commit. The shared
  **Tagged commits only** toggle filters both sides, selecting the newest loaded
  tagged commit if the current selection is hidden. Load older commits to find
  additional tags. Search filters **loaded** messages,
  authors, tags, and full commit IDs; use **Load older commits** to extend the searchable history.
- Changing a project clears its commit selection. Late responses for previous
  project selections are discarded. Loading errors offer a retry.

**Confirm selection** prepares an archived project branch for **each selected
project/commit pair**, then opens a comparison of both prepared Flows, with directed
dependency links and names beneath each node. Datasets use blue rectangles,
recipes yellow circles, ML recipes green circles, and trained models green
diamonds. Managed folders and other computables currently use blue rectangles
too. ELK arranges nodes left to right and groups zoned projects into panels.
The legend follows [DSS Visual Grammar](https://doc.dataiku.com/dss/latest/flow/visual-grammar.html):
blue squares for datasets, yellow circles for visual recipes, orange circles for
code recipes, red circles for plugin recipes, and green ML items. It also includes
pink diamonds for agents, pink circles for LLM recipes, and green circles for
agent tools.
Custom plugin recipes (`CustomCode_…`) whose icons are unavailable use an empty
red circle without a question mark or missing-icon message.
Saved models with an agent `savedModelType` (such as `STRUCTURED_AGENT`) display
a pink diamond with an agent icon, using the settings already in the snapshot.
Drag the diagram (or use arrow
keys while it is focused) to pan; mouse-wheel and trackpad zoom stays centered
at the pointer. Toolbar zoom uses the viewport center. **Fit** includes the SVG
geometry, wrapped labels, and 32 pixels of padding. Each completed load
automatically fits the entire Flow using the same framing as the Fit button.

Navigation transforms the canvas without rearranging nodes. During the current
page session, each baseline project retains its positions when the
same topology and label dimensions are redrawn, even if API ordering changes.
Changed topology, zone ownership, kinds, or label/header dimensions trigger a new
layout; text/color changes within the same dimensions reuse positions. This does not persist manual layout edits or survive
a page reload. **Change selection** returns to the form without clearing it.
Empty Flows and loading errors are shown explicitly, with retry on failure.

The Flow view reads both generated projects after both revisions have been
verified and archived. The screen shows the comparison direction, generated
project keys and branch names, and whether each artifact was created or reused.
Selection still emits this DOM event:

```javascript
document.addEventListener("flowdiff:selection", (event) => {
    // event.detail contains full commit IDs, not abbreviated display values.
    // {
    //   mode: "same-project" | "cross-project",
    //   baseline: { projectKey: "PARENT", commitId: "<full SHA>" },
    //   target: { projectKey: "BRANCH", commitId: "<full SHA>" }
    // }
});
```

The source projects are never checked out, reset, or switched. Revision selection
modifies generated projects; registry initialization can also update the hosting
project's selected dataset schema. Selection is kept in memory until reload.

## Comparing Flow versions

`GET /comparison?baselineProjectKey=...&targetProjectKey=...` reads both archived
copies using the viewer client. It returns `baseline` and `target` snapshots,
object `counts`, `zoneCounts`, and the combined display `graph`.

A snapshot has `schemaVersion`, `projectKey`, `warnings`, and `model`:

```json
{
  "schemaVersion": 1,
  "projectKey": "VFD_TSHIRTS_B82CF7BB",
  "warnings": [],
  "model": {
    "objects": {
      "[\"COMPUTABLE_DATASET\",\"customers\"]": {
        "id": "[\"COMPUTABLE_DATASET\",\"customers\"]",
        "name": "customers",
        "kind": "dataset",
        "type": "COMPUTABLE_DATASET",
        "subType": null,
        "zoneId": "default",
        "coverage": "settings",
        "config": {"schema": {"columns": [{"name": "id", "type": "string"}]}},
        "inputs": [],
        "outputs": [],
        "sharedWith": []
      }
    },
    "zones": {"default": {"id": "default", "name": "Default", "color": "#D1D8DA", "isDefault": true}}
  }
}
```

Object identities combine DSS object type and reference; graph IDs from different
project copies are mapped onto those identities. Own-project namespaces normalize
to `$project` in configuration values. Root `projectKey`, `versionTag`,
`creationTag`, and `creationOrigin` bookkeeping fields are excluded. Dictionary
keys and graph adjacency are sorted; configuration array order is preserved.
A rename or changed object ID is currently a deletion plus an addition.

Datasets, managed folders, saved models, and knowledge banks use their public
settings APIs. Knowledge banks (`COMPUTABLE_RETRIEVABLE_KNOWLEDGE`) use
`get_knowledge_bank(...).get_settings().get_raw()` and display their configured
names. Their settings are compared; stored documents and embeddings are not read.
Search tools (`VectorStoreSearch`) connect their configured
`params.knowledgeBankRef` bank to the named tool, then to the agent. These
connections use IDs from settings rather than guessing from tool names.
An implicit agent dependency aggregate is removed when all its inputs are
accounted for by explicit tool connections. Unresolved aggregates are retained
as “Dependencies for <agent name>” with graph-only coverage.
Knowledge-bank icons use the Flow object type, even when their settings have
no `type` field; search tools use the knowledge-bank tool icon.
Implicit agent dependency references such as `agentdep->PROJECT.agentId`
normalize the generated project's namespace to `agentdep->$project.agentId`
in identities, labels, and graph metadata. This prevents identical dependencies
from appearing added/deleted solely because the generated project keys differ.
Foreign-project namespaces and actual changes to the referenced agent remain
distinct. Local implicit dependencies retain graph-only coverage because they
are generated links rather than independently readable settings objects.
Referenced agent tools are first-level comparison objects with green tool icons,
their own Inspect entries, and dependency links from each tool to its agent.
Tool-using agents and nested visual-agent blocks (including manual tool calls)
are scanned in the active inline version. A shared tool appears once, in the
first referencing agent's zone; links into other zones create reference appearances.
Tool settings, including Python source and plugin/visual configuration, are read
with `get_agent_tool(...).get_settings().get_raw()` and compared independently.
Tool additions, removals, and edits receive the same statuses and JSON inspector
as other objects. Foreign-project tools retain explicit external-reference
coverage warnings. Tools referenced only in code or inactive versions are not
inferred, and unreferenced tools are not added to the comparison.
Recipes include both raw definitions and payloads: code scripts remain strings,
while visual recipe JSON payloads are parsed structurally. An unreadable supported
configuration fails the comparison instead of being treated as unchanged.
External references and implicit/unsupported Flow objects retain graph metadata
with explicit coverage warnings. Their external or implicit configurations are
not fully compared. The model does not include scenarios, notebooks, dashboards,
other objects outside the Flow, dataset contents, or trained-model binaries.

Changes are directional from baseline to comparison. Only-baseline objects are
**deleted**; only-comparison objects are **added**; matched objects with changed
settings, names, connections, zone ownership, or sharing are **modified**.
Zone name/color and presence changes are compared separately. The union keeps
removed objects and connections visible. Matched objects use the comparison's
zone; deleted objects retain their baseline zone. This can differ from either
individual project's layout.

The visual comparison uses red dashed deleted connections, green additions,
amber modifications, and muted unchanged items. Changed objects have a halo,
a symbol badge, and a status label. Compressed zone connectors aggregate the
statuses of their underlying connections; mixed statuses display as modified.
The existing node shapes, zone panels, dimmed shared inputs, pan/zoom, and Fit
remain available. Cached layouts and cameras are scoped to the project pair.

Expand **Project structures and JSON diff** to see aligned baseline/comparison
JSON with line numbers and changed rows. The default shows both complete
canonical Flow structures. Choose an object in **Inspect**, or click/focus a Flow
item and press Enter, to inspect only its configuration and topology. JSON
alignment follows object keys and array indices; missing values leave blank rows
on that side. Payloads are rendered as text, never inserted as HTML. Rendering
is deferred while the panel is folded.

Selecting a Python, R, SQL, Scala/Spark, or shell code recipe opens the **Recipe
code** tab automatically. It compares only the source in the recipe payload,
with original indentation, line breaks, blank lines, and source line numbers.
Inserted/deleted lines stay aligned with unchanged code. Added or deleted recipes
leave the absent side blank. Switch to **JSON diff** to inspect the full object;
the code tab is available only for code recipes. Source is displayed as stored,
without reformatting that could change code semantics or hide whitespace edits.

Deploy the complete plugin, including new `python-lib/visualflowdiff/comparison.py`
and `resource/flow-comparison.js`, updated HTML/CSS/JavaScript, backend, and layout
adapter. Restart the Python backend and reload the frontend. The registry schema
and existing archived copies remain reusable.

## Cleaning up comparison projects

Use **Clean up comparison projects** on the initial selection screen, then
**Delete registered projects** to confirm permanent project deletion. This
applies to all generated copies recorded in the selected registry, independently
of the currently selected comparison. The backend runs cleanup as the viewer;
project administration rights are required. The registry connection role also
needs `DELETE` permission, checked before any project is deleted.

Cleanup rechecks the source relationship and recorded ownership nonce, protects
the hosting project and registered source projects, and never clears underlying
dataset or managed-folder data. Foreign-instance, corrupt, or unverified entries
are retained and reported. A project already absent is treated as stale metadata.
Each registry row is removed only after verifying its project is absent; failed
deletions and failed SQL updates retain their rows so cleanup can be retried.
Duplicate record keys stop cleanup before deletion.
On DSS 15, settings access for an absent project can report
`UnauthorizedException: Failed to read project permissions`. Cleanup confirms
that particular response against a fresh viewer project list, including archived
projects. Ordinary permission denials remain failures. Retry reconciles stale
registry rows for copies already deleted by an earlier cleanup attempt.
Per-entry failures identify whether access checking, deletion, absence
verification, or registry removal failed. Detailed exceptions are recorded in
the webapp's Python backend logs.

Cleanup runs in the background with progress and per-entry results. Preparation
and cleanup cannot overlap in the same backend. A successful response clears
cached Flow views and refreshes project choices. Source Git branches are not
deleted. Deleting a generated project removes its project-local repository.

## Comparison preparation

`POST /prepare-comparison` accepts the selection above as JSON with
`X-Requested-With: XMLHttpRequest`. Both source revisions are resolved to full
SHAs before project creation. The response is HTTP 202 with a `jobId`;
`GET /preparation/<jobId>` reports `preparing`, `ready`, or `failed`, progress
messages, and any successful side's artifact. Jobs are visible only to their
initiating viewer. The frontend waits for both sides before requesting their comparison.

The backend uses the public
[DSS project Git API](https://developer.dataiku.com/latest/api-reference/python/projects.html):

1. Identify artifacts by DSS instance, source project key, and full commit SHA,
   independently of baseline/comparison role. Commit a registry row and a random
   duplication branch nonce **before** making the remote write.
2. Allocate a project key `VFD_<source-prefix>_<commit-SHA8>`, using the first
   eight commit characters in uppercase and a source prefix up to 20 characters.
   For example, `VFD_TSHIRTS_B82CF7BB`. Add a numeric suffix for confirmed
   collisions, including two full SHAs with the same first eight characters.
   Reuse still uses the full commit SHA and existing recorded project keys;
   existing copies keep their names. Never adopt an unrelated project by name.
3. Call the **source** project's `get_project_git().create_branch()` with
   `duplicate_project=True`, the reserved `target_project_key`, selected `commit`,
   and a unique bootstrap branch name. DSS chooses the destination project folder.
4. In the **generated** project, create `vfd_<identity-hash>` at the selected
   SHA using `create_branch(..., duplicate_project=False)`. This second call is
   necessary because DSS 15.1's duplication path does not forward the requested
   commit to project duplication. The source repository is never switched.
5. Verify branch, revision, clean working tree, origin, and the recorded nonce.
   DSS can preserve an existing Git origin when duplicating a branch project.
   Record that source origin before duplication and accept either the actual
   selected source or its recorded inherited origin, always together with the
   unique bootstrap branch marker. The selected project remains part of the
   registry identity, so sibling branches with the same commit are distinct.
   DSS can append an invariant-restoration commit after checkout; only its exact
   server message immediately following the selected SHA is accepted. Record
   the verified HEAD, including that DSS commit when present.
6. Set only `projectStatus` to `Archived` through project settings, save, and
   re-read to verify archiving. DSS can commit this settings update. Accept an
   immediate settings-update commit only when the public Git diff proves that
   `params.json` changed solely to set the root project status to `Archived`,
   along with its root `versionTag` metadata. Other project settings and all
   Flow object changes are rejected. Persist the resulting verified HEAD and
   check the branch and clean working tree again. Archive partial generated
   projects as soon as possible and again after checkout, since checkout can
   restore the source's status. No builds or scenario runs are started.

Archiving uses DSS's project lifecycle status; it does not change project access
permissions or delete projects. Archived projects remain accessible through APIs
and can be found through DSS's archived-project views.

Repeated selections and reversed comparison roles reuse registered projects
after re-verifying provenance, branch, HEAD, and archive status. Each change
is saved with a targeted Snowflake `MERGE` and an explicit `COMMIT` through
[DSS SQLExecutor2](https://developer.dataiku.com/latest/concepts-and-examples/sql.html).
This is persistence only; it does not implement database coordination. Unknown
duplication outcomes (for example a timeout) retain the reserved key so retries
inspect that exact project instead of creating another blindly. Modified or
unrelated artifacts fail without resetting, deleting, or replacing them.
Retry also recovers copies retained by the previous archive/HEAD verification
error. The stored pre-archive revision is checked against the immediate settings
commit and its actual diff before updating the registry; no recreation is needed.
The same check covers a lost registry-save response after successful archiving,
and a timeout after checkout before the pre-archive HEAD was saved.
Records created before branch-lineage support are backfilled from the selected
source's Git status. Preparation and cleanup can then resume verified copies
previously rejected by the immediate-source-only provenance check. This adds a
field in `RECORD_JSON`; no registry table schema migration is required.

If only one side succeeds, its result stays visible and is reused on retry. A
failure retains recovery metadata and proven generated projects; no automatic
deletion occurs. Preparation continues if the viewer returns to selection.

Job handles are in memory in the DSS backend process; after a restart or expired
handle, use **Retry** to resume from the dataset records. Deployments with
multiple independent preparation workers are outside the single-writer model.
Keep the registry dataset and table when upgrading or moving the backend:
losing them loses the ownership records required to reuse existing artifacts safely.

### Migrating existing JSON records

If you used the previous filesystem registry, stop preparation and retain its
JSON records before switching storage. Load those objects into a DSS notebook
and explicitly import each one using the helper below. No directory is needed
by the new webapp. Import preserves project keys, branch names, nonce, and progress;
it is repeatable and rejects a conflicting existing record.

```python
import dataiku
from visualflowdiff.registry import Registry

dataset = dataiku.Dataset("comparison_registry")
registry = Registry(dataset, dataiku.SQLExecutor2(dataset=dataset))
# legacy_records is a list of parsed JSON records exported from the old registry.
for record in legacy_records:
    registry.import_record(record)
```

If no comparison projects were prepared previously, start with an empty table.
The existing project's provenance and revision are checked again before reuse.

Backend calls include browser credentials even when DSS serves the backend on
a different origin. Session identification failures return HTTP 401 with sign-in
and cookie guidance; rejected impersonation returns HTTP 403 with permission
guidance. Project access never falls back to the run-as user's permissions. Browser
or proxy cookie restrictions may still require deployment configuration changes.

## ELK layout and deployment

Layout uses bundled **ELK.js 0.12.1** through `resource/flow-layout.js`. ELK Layered
calculates the positions and orthogonal connection routes; SVG still draws the
shapes and handles pan/zoom. Projects with named zones use a compound graph:
each zone is a container with a colored title bar and its owned items as children.
The default zone is shown when it contains items; named empty zones are retained.
Projects without named zones use a flat ELK graph. Each canonical item is drawn
once in its owning zone. External inputs additionally appear as dimmed shapes
with dashed outlines in receiving zones, with their names underneath. Local
recipe connections start at these references. Sharing between each directed
zone pair is compressed into one thicker solid connector, attached to zone
borders. There are no item-to-reference lines across zones. Hovering the zone
connector shows the source, destination, and number of shared items; hovering
a reference identifies its originating zone. Shared references
are deduplicated per zone/item pair, including when multiple recipes consume the
same input. Explicit pre-shares without a consumer are also shown. These are
visual appearances: item and dependency counts still refer to the canonical
graph, and no DSS sharing settings are modified.

Zone focus/collapse and view switching are not included.

Node bounds reserve space for wrapped labels and shape ports. Zone bounds reserve
header space and internal padding. Edge sections are translated using the ELK
container they belong to, including sections returned on the root graph. The
outer layout connects zone ports, while internal dependencies connect local
items/reference appearances. Zone connectors are drawn behind the panels.
ELK can
break cycles for positioning while retaining every original directed dependency.
Inputs are sorted and use a fixed layout seed. An asynchronous layout result is
discarded if the user leaves the screen or selects another Flow before it finishes.

The layout runs in the packaged web worker when the browser allows it. If workers
cannot be constructed, the same bundled engine runs on the main thread. Worker
load failures and layout errors show a retryable error; the old column fallback
is removed. Layout is cached for the page session; pan, zoom, and Fit never invoke
the layout engine.

Deploy **the entire plugin**, including `python-lib/`, `resource/`,
`webapp.json`, `backend.py`, `style.css`, `body.html`, and `app.js`. Configure the
registry and restart the backend. The HTML loads scripts relative to DSS's plugin component base URL:

```text
/plugins/visual-flow-diff/resource/vendor/elk.bundled.js
/plugins/visual-flow-diff/resource/vendor/elk-worker.min.js
/plugins/visual-flow-diff/resource/flow-layout.js
```

No CDN, runtime npm installation, or external network access is required. Reload
the webapp frontend after updating the plugin. If resources return 404, check
that the plugin package contains `resource/`, and that the webapp HTML was updated.
Dependency provenance and the upstream license are in `resource/vendor/`.

## Zone data in the Flow response

`GET /comparison?baselineProjectKey=...&targetProjectKey=...` reads each prepared
project's graph and zones using the viewer client. Zone settings are read through the public
[`list_zones()` and `get_settings().get_raw()` APIs](https://developer.dataiku.com/latest/api-reference/python/flow.html).
There are no requests per zone item and no settings are saved.

The response's `graph` contains `nodes`, `edges`, and zone metadata for the
comparison layout. Its zone-related fields have the following structure:

```json
{
  "hasZones": true,
  "nodes": [
    {"id": "input", "name": "input", "kind": "dataset", "zoneId": "default"},
    {"id": "prepare", "name": "prepare", "kind": "recipe", "zoneId": "clean"}
  ],
  "edges": [{"source": "input", "target": "prepare"}],
  "zones": [
    {
      "id": "default", "name": "Default", "color": "#D1D8DA", "isDefault": true,
      "nodeIds": ["input"], "sharedNodeIds": [], "references": [], "unresolvedItems": []
    },
    {
      "id": "clean", "name": "Clean", "color": "#27a9df", "isDefault": false,
      "nodeIds": ["prepare"], "sharedNodeIds": ["input"],
      "references": [{
        "appearanceId": "[\"clean\",\"input\"]",
        "nodeId": "input", "ownerZoneId": "default", "reasons": ["dependency", "shared"]
      }],
      "unresolvedItems": []
    }
  ]
}
```

- Each graph node has exactly one `zoneId`. Membership is resolved using object
  type and project-qualified reference, keeping foreign objects distinct.
- `nodeIds` lists the zone's owned nodes. Unassigned nodes go to `default`, which
  is synthesized if DSS omits it; a returned default zone's name/color are kept.
  Empty zones are retained. `hasZones` means at least one non-default zone exists.
- `sharedNodeIds` lists explicit pre-shares. `references` lists non-owning
  appearances, merging explicit sharing (`shared`) with references derived from
  incoming cross-zone edges (`dependency`). The underlying node/edge lists are
  never duplicated. `appearanceId` is a JSON-encoded `[zoneId, nodeId]` pair,
  stable across display-name changes; it is an opaque identifier, not a selector.
- Implicit recipes without explicit membership follow their output's zone when
  all resolved outputs have the same owner. Otherwise they use `default`.
- `unresolvedItems` records metadata references absent from the graph, including
  their `items`/`shared` source, object type, project key, and object ID. They do
  not create fictitious nodes. Conflicting explicit owners fail the request.
- A failed zone lookup fails the comparison request with the existing error handling;
  it is not silently reported as a project without zones.

The local preview exercises the compound layout and includes an **Images and
documents** project reproducing an external `attachments-metadata` recipe input.
Zone navigation remains a separate next step.

## Local checks

The foldable **Project structures and JSON diff** panel keeps the complete Flow
JSON at the top of the screen. Clicking a Flow object or selecting it from
**Inspect** opens a large comparison overlay above the Flow. Close it using the
close buttons, Escape, or the backdrop. Closing preserves the comparison and
Flow position. Update `body.html`, `app.js` and `style.css` together when deploying.

Clicking a Split recipe opens **Visual Inspector** inside the overlay alongside **JSON diff**.
Range splits use compact, read-only From/To/Output tables in aligned
Baseline/Comparison columns. Brackets indicate inclusive or exclusive bounds;
pre-filter conditions appear as single-line expressions, and input/output settings
use compact rows. The overlay fits its contents up to the available screen height.
Changed fields use red for previous values and green
for new values. Output indexes are resolved independently in each snapshot, so
reordering the output list does not imply a destination change. Input references,
output membership and append/overwrite modes are available in a collapsible
section. The full configuration remains available for technical metadata and
settings outside the visual layout. Other Split strategies show an explicit
notice and retain JSON access. This inspector is read-only.

The preview includes a **Split recipe comparison** project based on the supplied
example, with a changed threshold, a removed condition and reordered outputs.

Prepare recipes (internal type `shaker`) also open **Visual Inspector** by default.
Aligned step pairs expand together, with changed steps open initially. Geo-IP
extraction and formula-column processors use familiar read-only field labels,
checkbox states and expression formatting. Previous values are red, new values
green; added and removed steps retain an explicit empty counterpart. Comments,
enabled state and extra parameters are included. Unknown processors show captured
parameter values instead of an incomplete specialized form. Missing settings,
empty scripts and missing recipe versions have explicit notices. The JSON tab
retains every captured setting, including editor preview, engine and sampling
metadata omitted from the visual view.

Prediction and clustering training recipes also open **Visual Inspector** by default.
They reuse Prepare's paired fields, read-only checkboxes, expandable sections and
red/green value highlights. Captured settings are grouped into training task,
input/output, features, algorithms, training/evaluation, runtime and additional
settings. Named parameters align by their full path, so added features and changed
hyperparameters do not shift unrelated fields. Ordered lists retain their order.
Changed sections open initially; unchanged sections remain collapsed. Unknown
settings are retained, and JSON diff remains available. Implicit training recipes
with graph-only coverage show an explicit unavailable-settings notice, because
those snapshots contain no training configuration. This panel compares captured
recipe settings, not trained model binaries or execution results.

The preview's **Model training comparison** project includes feature changes,
hyperparameter changes, an enabled algorithm, a changed train/test ratio and
added/removed settings.

Step alignment uses unique IDs where available, otherwise exact processor content
followed by unambiguous same-type edits between matching steps. Insertions do not
shift downstream comparisons. Ambiguous repeated processors and reordered steps
can appear as removals/additions rather than speculative field changes. The
**Prepare recipe comparison** preview reproduces the supplied country-code
extraction change and removed formula step.

Find / Replace **Replacements** and column **Renamings** use aligned source →
target rows. Changed targets are highlighted independently, with gaps for added
or removed rules. Ordered rules retain their execution order, including repeated
sources. Other fields containing source/target pairs use the same layout;
dictionary mappings use their keys. Objects and lists display as nested labeled
properties and lists instead of raw JSON text. Unfamiliar records retain all of
their attributes. The **Prepare mappings comparison** preview includes both
processors, a changed target, an added replacement and an updated column name.

Visual If Rule uses compact **If**, **Then**, **Else if** and **Else** statements
for supported conditions and assignments. Grouped conditions preserve AND/OR
parentheses, multiple actions retain their order, and column/formula assignments
are distinguished from literal values. Changed tokens retain the comparison
highlights. Unsupported conditions or actions fall back to the structured display.
The **Visual If Rule comparison** preview reproduces the visit-segment example.

From the repository root:

```sh
node --check webapps/webapp/app.js
node --test tests/test_app.js tests/test_layout.js tests/test_json_diff.js tests/test_split_inspector.js tests/test_prepare_inspector.js tests/test_training_inspector.js
python3 -m unittest discover -s tests -v
python3 tests/preview.py
```

UI tests use a layout double to exercise state transitions; `test_layout.js` runs
the vendored ELK engine itself, covering flat/compound graphs, cycles, edge
container coordinates, label containment, non-overlap, deterministic ordering,
empty zones, and a larger graph. Comparison tests cover canonical identity,
recipe/schema edits, deleted topology, zone changes, limited coverage, aligned
JSON, and clicking an object to inspect its changes.

The last command serves a standalone UI preview at `http://127.0.0.1:8765` with
synthetic projects and commits, including empty and unavailable projects. It
simulates preparation, polling, and reuse without connecting to DSS. Backend
tests cover revision verification, timeout recovery, name collisions, modified
artifacts, partial failure, and the single-active-preparation guard. Registry
tests use SQLite for persistent reads and SQL value expressions, translating the
Snowflake MERGE operation for local execution. This does not validate Snowflake's
SQL engine. An actual DSS/Snowflake instance is still needed to verify runtime
integration, SQL execution, and deployment permissions.

The backend uses the public [project Git API](https://developer.dataiku.com/latest/api-reference/python/projects.html),
including `get_project_git().log(start_commit=..., count=50)` and
`get_project_git().get_status()` for branch relationships. Branch discovery
checks Git status for accessible candidate projects only when branch mode is
selected, its baseline changes, or discovery is retried.
