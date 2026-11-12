/**
 * Manage project and commit selection for the Visual Flow Diff webapp.
 * Confirmed revisions are emitted as a `flowdiff:selection` document event,
 * then prepared as archived project branches before displaying baseline Flow.
 * This module does not compute a diff or persist the selection.
 */
(function () {
    "use strict";

    /** @param {string} id Element ID. @returns {HTMLElement|null} Matching element. */
    const $ = (id) => document.getElementById(id);

    /**
     * Mutable revision state and DOM controls for one comparison side.
     *
     * @typedef {Object} RevisionSide
     * @property {string} id Side identifier: `base` or `target`.
     * @property {string} project Selected project key, or an empty string.
     * @property {string} selected Selected full commit ID, or an empty string.
     * @property {Array<{id: string, message: string, author: string, timestamp: ?string, tags: string[], inRegistry: ?boolean}>} commits Loaded history.
     * @property {?string} registryWarning Registry lookup warning for loaded history.
     * @property {?string} next Pagination cursor for older commits.
     * @property {number} version Request generation used to discard stale responses.
     * @property {boolean} loading Whether the current history request is pending.
     * @property {boolean} error Whether the latest history request failed.
     * @property {HTMLSelectElement} select Project selector.
     * @property {HTMLInputElement} search Commit search field.
     * @property {HTMLElement} list Commit radio group.
     * @property {HTMLElement} status Loading, result count, or error message.
     * @property {HTMLButtonElement} more Pagination and retry button.
     */
    /** @type {Object<string, RevisionSide>} */
    const sides = {};
    const membershipRequests = new Map();
    let projects = [];
    let branchProjects = [];
    let branchRequestVersion = 0;
    let confirmed = false;
    let cleanupRunning = false;
    let flowRequestVersion = 0;
    let iconRevision = "";
    const flowViews = new Map();
    let currentFlowView = null;
    let flowContent = null;
    let cameraFrame = null;
    let panGesture = null;
    let panMoved = false;
    let currentComparison = null;
    let inspectedId = null;
    let activeDiffTab = 'json';
    let inspectorOpener = null;
    const changeLabels = { added: "Added", deleted: "Deleted", modified: "Modified", unchanged: "Unchanged" };
    const changeColors = { added: "#16a34a", deleted: "#ef4444", modified: "#f59e0b", unchanged: "#94a3b8" };
    /** @returns {boolean} Whether both revisions must use the baseline project. */
    const sameProject = () => document.querySelector('input[name="scope"]:checked').value === "same-project";

    /**
     * Read a JSON endpoint using DSS's backend URL and browser credentials.
     * Empty query values are omitted. Failures become user-facing errors.
     *
     * @param {string} path Backend route name.
     * @param {Object<string, string|null>} [params={}] Query parameters.
     * @param {Object} [body] Optional JSON body; supplying it sends a POST.
     * @returns {Promise<Object>} Parsed response body.
     * @throws {Error} If the request fails or the response is not JSON.
     */
    async function api(path, params = {}, body) {
        const url = new URL(getWebAppBackendUrl(path), window.location.href);
        Object.entries(params).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
        const options = { credentials: "include" };
        if (body !== undefined) {
            options.method = "POST";
            options.headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        let result;
        try { result = await response.json(); } catch (_) {
            if (response.status === 401 || response.status === 403) throw new Error("DSS could not authenticate this request. Sign in to DSS and reload the webapp.");
            throw new Error(`The backend returned an unexpected response (HTTP ${response.status}). Check the webapp backend logs and retry.`);
        }
        if (!response.ok) throw new Error(result.error || "The request failed. Please retry.");
        return result;
    }

    /**
     * Build the event payload using full commit IDs rather than display SHAs.
     *
     * @returns {{mode: string, baseline: {projectKey: string, commitId: string}, target: {projectKey: string, commitId: string}}}
     */
    function selection() {
        const ref = (side) => ({ projectKey: side.project, commitId: side.selected });
        return { mode: sameProject() ? "same-project" : "cross-project", baseline: ref(sides.base), target: ref(sides.target) };
    }

    /**
     * Refresh the selection summary and enable confirmation only for valid refs.
     * Branch mode requires a project associated with the baseline; same-project mode requires
     * distinct commits. Selection changes invalidate prior confirmation.
     *
     * @param {boolean} [changed=true] Whether to clear the confirmation state.
     */
    function updateReview(changed = true) {
        if (changed) confirmed = false;
        const a = sides.base;
        const b = sides.target;
        const complete = Boolean(a.project && b.project && a.selected && b.selected);
        const identical = complete && a.project === b.project && a.selected === b.selected;
        const needsOtherProject = !sameProject() && a.project && a.project === b.project;
        const invalidBranch = !sameProject() && b.project && !branchProjects.some((project) => project.key === b.project);
        const name = (side) => {
            const project = projects.find((entry) => entry.key === side.project);
            return `${project ? project.name : side.project} · ${side.selected.slice(0, 8)}`;
        };
        $("confirm-selection").disabled = cleanupRunning || !complete || identical || Boolean(needsOtherProject || invalidBranch);
        $("selection-summary").textContent = complete ? `${name(a)} → ${name(b)}` : "Choose a project and a commit on each side.";
        $("selection-status").textContent = needsOtherProject || invalidBranch ? "Choose a branch associated with the baseline project." : identical ? "Choose two different revisions to compare." : confirmed ? "Selection confirmed." : "";
        $("selection-status").classList.toggle("error", identical || Boolean(needsOtherProject || invalidBranch));
    }

    const eligibleCommits = (side) => side.commits.filter((commit) =>
        !$("tagged-commits-only").checked || (commit.tags && commit.tags.length));

    function selectEligibleCommit(side) {
        const eligible = eligibleCommits(side);
        const defaultIndex = side.id === "target" && sameProject() ? 1 : 0;
        if (!eligible.some((commit) => commit.id === side.selected)) side.selected = eligible[defaultIndex]?.id || "";
    }

    /**
     * Render loaded commits matching the shared tag filter and local search.
     * Preserve the selected commit when filtering and insert metadata as text.
     *
     * @param {RevisionSide} side Comparison side to render.
     */
    function renderCommits(side) {
        const query = side.search.value.trim().toLocaleLowerCase();
        const visible = eligibleCommits(side).filter((commit) => [commit.id, commit.message, commit.author, ...(commit.tags || [])].join(" ").toLocaleLowerCase().includes(query));
        side.list.replaceChildren();
        visible.forEach((commit) => {
            const label = document.createElement("label");
            label.className = "commit-option";
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = `${side.id}-commit`;
            radio.value = commit.id;
            radio.checked = commit.id === side.selected;
            radio.addEventListener("change", () => { side.selected = commit.id; updateReview(); });
            const copy = document.createElement("span");
            copy.className = "commit-copy";
            const message = document.createElement("span");
            message.className = "commit-message";
            message.textContent = commit.message;
            const meta = document.createElement("span");
            meta.className = "commit-meta";
            const date = commit.timestamp ? new Date(commit.timestamp) : null;
            meta.textContent = `${commit.id.slice(0, 8)} · ${commit.author}${date && !Number.isNaN(date.getTime()) ? ` · ${date.toLocaleString()}` : ""}`;
            meta.title = commit.id;
            copy.append(message, meta);
            if (commit.inRegistry === true) {
                const badge = document.createElement("span");
                badge.className = "commit-registry-badge";
                badge.textContent = "In registry";
                badge.title = "This project revision has a comparison registry entry.";
                copy.append(badge);
            }
            if (commit.tags && commit.tags.length) {
                const tags = document.createElement("span");
                tags.className = "commit-meta commit-tags";
                tags.textContent = `Tags: ${commit.tags.join(", ")}`;
                const bundleTag = /^(\s*(?:refs\/tags\/)?dss-bundle-[A-Za-z0-9_]+-)(.+)(-\d{4}(?:-\d{2}){5}-\d{3})$/;
                if (commit.tags.some((tag) => bundleTag.test(tag))) {
                    tags.textContent = "Tags: ";
                    commit.tags.forEach((tag, index) => {
                        const entry = document.createElement("span");
                        const match = tag.match(bundleTag);
                        if (match) {
                            const prefix = document.createElement("span");
                            prefix.textContent = match[1];
                            const bundle = document.createElement("strong");
                            bundle.className = "commit-bundle-id";
                            bundle.textContent = match[2];
                            const suffix = document.createElement("span");
                            suffix.textContent = match[3];
                            entry.append(prefix, bundle, suffix);
                        } else {
                            entry.textContent = tag;
                        }
                        if (index) {
                            const separator = document.createElement("span");
                            separator.textContent = ", ";
                            tags.append(separator);
                        }
                        tags.append(entry);
                    });
                }
                copy.append(tags);
            }
            label.append(radio, copy);
            side.list.append(label);
        });
        if (!side.error) {
            side.status.textContent = side.loading ? "Loading commits…" : !side.project ? "Select a project to see its commits." : !side.commits.length ? "This project has no selectable commits." : !visible.length ? "No matching commits. Try another search or load older commits." : `${visible.length} of ${side.commits.length} loaded commits · newest first`;
            if (!side.loading && side.registryWarning) side.status.textContent += ` · ${side.registryWarning}`;
        }
        side.list.setAttribute("aria-busy", String(side.loading));
        side.more.hidden = !side.next && !side.error;
        side.more.disabled = side.loading;
        side.more.textContent = side.error ? "Retry loading commits" : "Load older commits";
        side.search.disabled = !side.commits.length;
    }

    /** Enrich a loaded page without delaying selection; share simultaneous lookups. */
    async function loadRegistryMembership(side, entries) {
        if (!entries.length) return;
        const projectKey = side.project;
        const commitIds = entries.map((entry) => entry.id).sort().join(",");
        const key = JSON.stringify([projectKey, commitIds]);
        let pending = membershipRequests.get(key);
        if (!pending) {
            pending = api("registry-membership", { projectKey, commitIds });
            membershipRequests.set(key, pending);
        }
        // References distinguish a new load of the same project from this page.
        const current = () => side.project === projectKey && entries.some((entry) => side.commits.includes(entry));
        try {
            const result = await pending;
            if (!current()) return;
            const registered = new Set(result.registeredCommitIds);
            entries.forEach((entry) => {
                // Preparation may have registered this revision while the read was pending.
                entry.inRegistry = entry.inRegistry === true || registered.has(entry.id);
            });
            if (side.commits.every((entry) => typeof entry.inRegistry === "boolean")) side.registryWarning = null;
        } catch (_) {
            if (!current()) return;
            side.registryWarning = "Registry status unavailable. Check registry dataset settings and access, then reload commits.";
        } finally {
            if (membershipRequests.get(key) === pending) membershipRequests.delete(key);
            if (current()) renderCommits(side);
        }
    }

    /**
     * Fetch a history page, deduplicate commit IDs, and expose retryable errors.
     * Request versions prevent responses for obsolete selections from changing
     * the current side's history or loading state.
     *
     * @param {RevisionSide} side Comparison side to load.
     * @param {boolean} [append=false] Use the next cursor and retain loaded commits.
     * @returns {Promise<void>} Resolves after loading or displaying an error.
     */
    async function loadCommits(side, append = false) {
        const version = ++side.version;
        side.loading = true;
        side.error = false;
        side.status.classList.remove("error");
        renderCommits(side);
        try {
            let cursor = append ? side.next : null;
            let result, valid;
            // Skip pages containing only setup commits so a valid default can be found.
            do {
                result = await api("commits", { projectKey: side.project, startCommit: cursor });
                if (version !== side.version) return;
                valid = result.commits.filter((commit) => !commit.message.includes("Initialize gitignore"));
                const previous = cursor;
                cursor = result.nextCommit || null;
                if (cursor === previous) break;
            } while (!valid.length && cursor);
            const entries = append ? side.commits.concat(valid) : valid;
            side.commits = Array.from(new Map(entries.map((commit) => [commit.id, commit])).values());
            side.next = cursor;
            selectEligibleCommit(side);
            updateReview();
            void loadRegistryMembership(side, valid);
        } catch (error) {
            if (version !== side.version) return;
            side.error = true;
            side.status.textContent = error.message;
            side.status.classList.add("error");
        } finally {
            if (version === side.version) {
                side.loading = false;
                renderCommits(side);
            }
        }
    }

    /**
     * Reset a side's history, search, and commit selection for a project change.
     * Invalidate pending requests and start loading if a project is selected.
     *
     * @param {RevisionSide} side Comparison side to reset.
     * @param {string} key Project key, or an empty string to clear the side.
     */
    function setProject(side, key) {
        ++side.version; // Discard responses for a previously selected project.
        side.project = key;
        side.select.value = key;
        side.selected = "";
        side.commits = [];
        side.registryWarning = null;
        side.next = null;
        side.error = false;
        side.loading = false;
        side.search.value = "";
        side.status.classList.remove("error");
        updateReview();
        renderCommits(side);
        if (key) loadCommits(side);
    }

    /**
     * Load only direct branch projects of the current baseline for comparison.
     * Clear the old target immediately and discard responses after scope or
     * baseline changes. Partial discovery keeps known branches and offers retry.
     *
     * @returns {Promise<void>} Resolves after loading or displaying an error.
     */
    async function loadBranches() {
        const version = ++branchRequestVersion;
        const baseline = sides.base.project;
        branchProjects = [];
        setProject(sides.target, "");
        sides.target.select.replaceChildren(new Option(baseline ? "Loading branches…" : "Select a baseline project first", ""));
        sides.target.select.disabled = true;
        $("retry-branches").hidden = true;
        $("same-project-note").classList.remove("error");
        $("same-project-note").textContent = baseline ? "Loading branches associated with the baseline project…" : "Select a baseline project to see its branches.";
        if (!baseline) return;
        try {
            const result = await api("branches", { projectKey: baseline });
            if (version !== branchRequestVersion) return;
            branchProjects = result.branches;
            sides.target.select.replaceChildren(new Option(branchProjects.length ? "Select a project branch" : "No associated branches available", ""));
            branchProjects.forEach((project) => sides.target.select.add(new Option(`${project.name} (${project.key})${project.branch ? ` · ${project.branch}` : ""}`, project.key)));
            sides.target.select.disabled = !branchProjects.length;
            $("same-project-note").textContent = result.incomplete ? "Some project relationships could not be checked. Showing verified branches only." : branchProjects.length ? "Only branches originating from the baseline project are shown." : "No accessible branch projects are associated with this baseline.";
            $("retry-branches").hidden = !result.incomplete;
        } catch (error) {
            if (version !== branchRequestVersion) return;
            sides.target.select.replaceChildren(new Option("Branches unavailable", ""));
            $("same-project-note").textContent = error.message;
            $("same-project-note").classList.add("error");
            $("retry-branches").hidden = false;
        }
    }

    /** Synchronize project controls and refresh branches for the selected scope. */
    function syncMode() {
        const same = sameProject();
        $("base-project-hint").hidden = same;
        $("target-project-hint").hidden = same;
        if (same) {
            ++branchRequestVersion;
            branchProjects = [];
            $("retry-branches").hidden = true;
            $("same-project-note").classList.remove("error");
            $("same-project-note").textContent = "Uses the same project as the baseline.";
            sides.target.select.replaceChildren(new Option("Select a project", ""));
            projects.forEach((project) => sides.target.select.add(new Option(`${project.name} (${project.key})`, project.key)));
            sides.target.select.disabled = true;
            sides.target.select.value = sides.base.project;
            if (sides.target.project !== sides.base.project) setProject(sides.target, sides.base.project);
        } else {
            loadBranches();
        }
        updateReview();
    }

    /**
     * Populate accessible projects and preselect the current DSS project.
     * Display a retry action if the backend cannot supply the project list.
     *
     * @returns {Promise<void>} Resolves after loading or displaying an error.
     */
    async function loadProjects() {
        $("retry-projects").hidden = true;
        $("project-status").textContent = "Loading projects…";
        $("project-status").classList.remove("error");
        try {
            const result = await api("projects");
            projects = result.projects;
            Object.values(sides).forEach((side) => {
                side.select.replaceChildren(new Option("Select a project", ""));
                projects.forEach((project) => side.select.add(new Option(`${project.name} (${project.key})`, project.key)));
                side.select.disabled = !projects.length;
            });
            $("project-status").textContent = projects.length ? "" : "No projects are available to your DSS account.";
            if (projects.some((project) => project.key === result.currentProjectKey)) {
                setProject(sides.base, result.currentProjectKey);
            }
            syncMode();
        } catch (error) {
            $("project-status").textContent = error.message;
            $("project-status").classList.add("error");
            $("retry-projects").hidden = false;
        }
    }

    let elkEngine = null;

    /** Create the bundled layout engine, using a worker when the browser supports it. */
    function getLayoutEngine() {
        if (typeof ELK === "undefined" || typeof FlowLayout === "undefined") {
            throw new Error("The Flow layout library could not be loaded. Reload the webapp and check that the plugin resource files are installed.");
        }
        if (!elkEngine) {
            let worker = null;
            if (typeof Worker === "function") {
                try {
                    worker = new Worker(new URL("../../resource/vendor/elk-worker.min.js", document.baseURI).href);
                } catch (_) { /* Use bundled ELK on the main thread if workers are unavailable. */ }
            }
            const failure = worker ? new Promise((resolve, reject) => {
                worker.addEventListener("error", () => reject(new Error("The Flow layout worker could not load. Reload the webapp and check the plugin resource files.")));
            }) : null;
            if (failure) failure.catch(() => {});
            const instance = worker ? new ELK({ workerFactory: () => worker }) : new ELK();
            elkEngine = {
                layout: (input) => {
                    const result = instance.layout(input);
                    return (failure ? Promise.race([result, failure]) : result).catch((error) => {
                        if (worker) worker.terminate();
                        elkEngine = null;
                        throw error;
                    });
                }
            };
        }
        return elkEngine;
    }

    /** Measure labels with the same font as the SVG before asking ELK for space. */
    function labelMeasurer() {
        const canvas = document.createElement("canvas");
        const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        if (!context) return (text) => text.length * 8;
        const style = getComputedStyle($("flow-graph"));
        context.font = `12px ${style.fontFamily}`;
        return (text) => context.measureText(text).width;
    }

    /** Create an SVG element with attributes and optional plain-text content. */
    function svgElement(tag, attributes = {}, text) {
        const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
        Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
        if (text !== undefined) element.textContent = text;
        return element;
    }

    /** Paint at most once per frame without recomputing node or edge positions. */
    function paintCamera() {
        if (!currentFlowView || !flowContent) return;
        $("flow-zoom-label").textContent = `${Math.round(currentFlowView.zoom * 100)}%`;
        if (cameraFrame !== null) return;
        cameraFrame = requestAnimationFrame(() => {
            cameraFrame = null;
            if (!flowContent || !currentFlowView) return;
            const { x, y, zoom } = currentFlowView;
            flowContent.setAttribute("transform", `translate(${x}, ${y}) scale(${zoom})`);
        });
    }

    /**
     * Zoom around a viewport point, preserving the graph coordinate beneath it.
     * Toolbar zoom uses the viewport center; wheel zoom supplies the pointer.
     */
    function setFlowZoom(zoom, point) {
        if (!currentFlowView) return;
        const viewport = $("flow-viewport");
        const anchor = point || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
        const next = Math.max(0.01, Math.min(4, zoom));
        const ratio = next / currentFlowView.zoom;
        currentFlowView.x = anchor.x - (anchor.x - currentFlowView.x) * ratio;
        currentFlowView.y = anchor.y - (anchor.y - currentFlowView.y) * ratio;
        currentFlowView.zoom = next;
        paintCamera();
    }

    /**
     * Frame measured SVG geometry, including wrapped labels, with 32px padding.
     */
    function fitFlow() {
        if (!currentFlowView) return;
        const viewport = $("flow-viewport");
        const bounds = currentFlowView.bounds;
        const width = Math.max(1, viewport.clientWidth - 64);
        const height = Math.max(1, viewport.clientHeight - 64);
        const fitted = Math.min(1, width / bounds.width, height / bounds.height);
        const zoom = Math.max(0.01, fitted);
        currentFlowView.zoom = zoom;
        currentFlowView.x = (bounds.width * zoom <= width ? (viewport.clientWidth - bounds.width * zoom) / 2 : 32) - bounds.x * zoom;
        currentFlowView.y = (bounds.height * zoom <= height ? (viewport.clientHeight - bounds.height * zoom) / 2 : 32) - bounds.y * zoom;
        paintCamera();
    }

    /** Bind direct-manipulation pan, pointer-centered wheel zoom, and keyboard pan. */
    function bindFlowNavigation() {
        const viewport = $("flow-viewport");
        viewport.addEventListener("pointerdown", (event) => {
            if (!currentFlowView || panGesture || event.button !== 0) return;
            panMoved = false;
            panGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: currentFlowView.x, startY: currentFlowView.y };
            viewport.focus({ preventScroll: true });
            event.preventDefault();
        });
        viewport.addEventListener("pointermove", (event) => {
            if (!panGesture || event.pointerId !== panGesture.id) return;
            // Capturing on pointerdown retargets the subsequent click to the
            // viewport instead of the node. Capture only an actual drag.
            if (!panMoved) {
                if (Math.abs(event.clientX - panGesture.x) + Math.abs(event.clientY - panGesture.y) <= 4) return;
                panMoved = true;
                viewport.setPointerCapture(event.pointerId);
                viewport.classList.add("is-panning");
            }
            currentFlowView.x = panGesture.startX + event.clientX - panGesture.x;
            currentFlowView.y = panGesture.startY + event.clientY - panGesture.y;
            paintCamera();
        });
        const stopPan = (event) => {
            if (!panGesture || event.pointerId !== panGesture.id) return;
            panGesture = null;
            viewport.classList.remove("is-panning");
            if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
        };
        ["pointerup", "pointercancel", "lostpointercapture"].forEach((name) => viewport.addEventListener(name, stopPan));
        viewport.addEventListener("wheel", (event) => {
            if (!currentFlowView) return;
            event.preventDefault();
            if (panGesture) return;
            const rect = $("flow-graph").getBoundingClientRect();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
            const delta = Math.max(-600, Math.min(600, event.deltaY * unit));
            setFlowZoom(currentFlowView.zoom * Math.exp(-delta * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        }, { passive: false });
        viewport.addEventListener("keydown", (event) => {
            if (!currentFlowView) return;
            const moves = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
            if (moves[event.key]) {
                event.preventDefault();
                currentFlowView.x += moves[event.key][0];
                currentFlowView.y += moves[event.key][1];
                paintCamera();
            }
        });
    }

    // DSS storage types often differ from the connection names used by the SVGs.
    const datasetIconAliases = {
        s3: "amazon-s3", gcs: "google-cloud-storage", azure: "microsoft-azure-blog-storage",
        azureblob: "microsoft-azure-blog-storage", "azure-blob": "microsoft-azure-blog-storage",
        azuresynapse: "microsoft-azure-synapse", synapse: "microsoft-azure-synapse",
        bigquery: "google-big-query", "big-query": "google-big-query", alloydb: "google-alloydb",
        postgresql: "postgresql", postgres: "postgresql", sqlserver: "microsoft-sql-server",
        "sql-server": "microsoft-sql-server", db2: "ibm-db2", hana: "sap-hana",
        elasticsearch: "elastic-search", uploadedfiles: "uploaded-files",
        filesystem: "filesystem", singlestore: "singlea-store", memsql: "singlea-store",
        pi: "pi-web", piweb: "pi-web"
    };

    const recipeIconAliases = {
        shaker: "prepare", grouping: "group", vstack: "stack",
        "prediction-training": "train", "clustering-training": "train",
        "prediction-scoring": "score", "clustering-scoring": "cluster",
        "clustering-complete": "cluster", "clustering-cluster": "cluster",
        "spark-scala": "scala", "spark-r": "rspark", sparkr: "rspark",
        "spark-sql": "spark-sql", "merge-folders": "merge-folder",
        "list-folder-contents": "list-folder-content", "application-recipe": "application-arecipe"
    };
    const pngRecipeIcons = new Set(["python", "r", "julia", "pig", "pyspark", "ksql", "impala", "spark-sql", "rspark", "hive", "sql", "shell", "scala"]);
    const modelIconAliases = {
        causal: "saved-model-causal", "causal-prediction": "saved-model-causal",
        "computer-vision": "saved-model-computer-vision", "deep-learning": "saved-model-deep-learning",
        timeseries: "saved-model-timeseries", "time-series": "saved-model-timeseries",
        "fine-tuning": "saved-model-fine-tuning", mlflow: "model-mlflow",
        azureml: "model-azureml", databricks: "model-databricks", sagemaker: "model-sagemaker",
        mes: "model-mes", "google-vertx": "model-google-vertx",
        llm: "model-llm", "llm-augmented": "model-llm-augmented",
        "llm-finetuned": "model-llm-finetuned"
    };

    function nodeIcon(node) {
        if (node.type === "COMPUTABLE_RETRIEVABLE_KNOWLEDGE") {
            return { type: node.type, filename: "computable-retrievable-knowledge.svg" };
        }
        if (node.kind === "agent-tool") {
            const type = node.config?.type || node.subType || "AGENT_TOOL";
            return { type, filename: type === "VectorStoreSearch" ? "agent-tool-knowledge-bank.svg" : "agent-tool-puzzle-piece.svg" };
        }
        const dataset = node.kind === "dataset";
        const model = node.kind === "model";
        if (model && /(?:^|_)AGENT$/.test(node.config?.savedModelType || "")) {
            const type = node.config.savedModelType;
            const filename = /STRUCTURED|VISUAL|TOOLS_USING/.test(type) ? "ai-agent-visual.svg" :
                /PYTHON|CODE/.test(type) ? "model-ai-agent-code.svg" :
                    /PLUGIN/.test(type) ? "ai-agent-plugin.svg" : "model-ai-agent.svg";
            return { type, filename, agent: true };
        }
        const type = String(dataset ? (node.config?.type || node.datasetType || node.subType || "unknown") :
            model ? (node.config?.modelType || node.config?.type || node.subType || "saved-model") :
                (node.config?.definition?.type || node.subType || node.recipeType ||
                    (node.type === "RUNNABLE_IMPLICIT_RECIPE" ? "prediction_training" : "unknown")));
        const slug = type.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
            .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
        const aliases = dataset ? datasetIconAliases : model ? modelIconAliases : recipeIconAliases;
        const basename = aliases[slug] || aliases[slug.replace(/-/g, "")] || slug;
        return { type, filename: `${basename}.${!dataset && !model && pngRecipeIcons.has(basename) ? "png" : "svg"}` };
    }

    /** Soften routed corners while preserving endpoints and short segments. */
    function roundedConnectorPath(points, radius = 14) {
        const route = [];
        points.forEach((point) => {
            const last = route[route.length - 1];
            if (last && last.x === point.x && last.y === point.y) return;
            // Port stubs can add redundant points along a straight segment.
            if (route.length > 1) {
                const previous = route[route.length - 2];
                const ax = last.x - previous.x, ay = last.y - previous.y;
                const bx = point.x - last.x, by = point.y - last.y;
                if (ax * by === ay * bx && ax * bx + ay * by > 0) route.pop();
            }
            route.push(point);
        });
        if (!route.length) return "";
        const commands = [`M ${route[0].x} ${route[0].y}`];
        for (let index = 1; index < route.length - 1; index++) {
            const previous = route[index - 1], corner = route[index], next = route[index + 1];
            const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y);
            const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
            const inset = Math.min(radius, incoming / 2, outgoing / 2);
            const entry = { x: corner.x + (previous.x - corner.x) * inset / incoming,
                y: corner.y + (previous.y - corner.y) * inset / incoming };
            const exit = { x: corner.x + (next.x - corner.x) * inset / outgoing,
                y: corner.y + (next.y - corner.y) * inset / outgoing };
            commands.push(`L ${entry.x} ${entry.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`);
        }
        if (route.length > 1) {
            const end = route[route.length - 1];
            commands.push(`L ${end.x} ${end.y}`);
        }
        return commands.join(" ");
    }

    /** Render ELK's positioned items, zone bounds, and routed dependency paths. */
    function renderFlow(graph, layout, signature, baseline) {
        const svg = $("flow-graph");
        svg.replaceChildren();
        const metadata = new Map(graph.nodes.map((node) => [node.id, node]));
        const nodes = new Map(layout.nodes.map((node) => [node.id, { ...node, ...metadata.get(node.id) }]));
        svg.append(svgElement("title", {}, `Flow comparison: ${nodes.size} items`));
        const defs = svgElement("defs");
        const arrow = svgElement("marker", { id: "flow-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
        arrow.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#8695a3" }));
        defs.append(arrow);
        Object.entries(changeColors).forEach(([status, color]) => {
            const marker = svgElement("marker", { id: `flow-arrow-${status}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
            marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
            defs.append(marker);
        });
        const edgeStatuses = new Map(graph.edges.map((edge) => [JSON.stringify([edge.source, edge.target]), edge.diffStatus || "unchanged"]));
        svg.append(defs);
        flowContent = svgElement("g", { id: "flow-content" });
        svg.append(flowContent);
        const zoneMetadata = new Map((graph.zones || []).map((zone) => [zone.id, zone]));
        // Draw compressed links beneath the panels, attached to their boundaries.
        layout.zoneLinks.forEach((edge) => {
            const source = zoneMetadata.get(edge.sourceZoneId)?.name || edge.sourceZoneId;
            const target = zoneMetadata.get(edge.targetZoneId)?.name || edge.targetZoneId;
            const d = edge.paths.map((points) => roundedConnectorPath(points)).join(" ");
            const path = svgElement("path", { d, class: "flow-zone-link",
                "data-source-zone": edge.sourceZoneId, "data-target-zone": edge.targetZoneId });
            const statuses = graph.edges.filter((link) => edge.nodeIds.includes(link.source) && metadata.get(link.target)?.zoneId === edge.targetZoneId).map((link) => link.diffStatus || "unchanged");
            path.setAttribute("data-diff-status", statuses.length && statuses.every((status) => status === statuses[0]) ? statuses[0] : "modified");
            path.append(svgElement("title", {}, `${source} → ${target} · ${edge.nodeIds.length} shared item${edge.nodeIds.length === 1 ? "" : "s"}`));
            flowContent.append(path);
        });
        layout.zones.forEach((position) => {
            const zone = { ...position, ...zoneMetadata.get(position.id) };
            const color = /^#[0-9a-f]{6}$/i.test(zone.color) ? zone.color : "#D1D8DA";
            const rgb = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
            const textColor = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 160 ? "#213348" : "white";
            const panel = svgElement("g", { class: "flow-zone", transform: `translate(${zone.x}, ${zone.y})`, "aria-label": `Zone: ${zone.name}`, "data-diff-status": zone.diffStatus || "unchanged" });
            panel.append(svgElement("rect", { width: zone.width, height: zone.height, rx: 5, fill: "white", stroke: "#cbd5df" }));
            panel.append(svgElement("rect", { width: zone.width, height: 28, fill: color }));
            panel.append(svgElement("text", { x: 14, y: 19, fill: textColor, "font-size": 12, "font-weight": 600 }, zone.name));
            flowContent.append(panel);
        });
        layout.edges.forEach((edge) => {
            edge.paths.forEach((points) => {
                const d = roundedConnectorPath(points);
                const status = edgeStatuses.get(JSON.stringify([edge.source, edge.target])) || "unchanged";
                flowContent.append(svgElement("path", { d, class: "flow-edge", "data-diff-status": status,
                    "marker-end": `url(#flow-arrow-${status})`, "stroke-linejoin": "round" }));
            });
        });
        const referenceNodes = layout.references.map((node) => ({ ...metadata.get(node.nodeId), ...node,
            name: metadata.get(node.nodeId).name, kind: metadata.get(node.nodeId).kind, diffStatus: metadata.get(node.nodeId).diffStatus }));
        [...nodes.values(), ...referenceNodes].forEach((node) => {
            const origin = node.isReference ? `, shared input from ${zoneMetadata.get(node.ownerZoneId)?.name || node.ownerZoneId}` : "";
            const canInspect = node.diffStatus === "modified";
            const group = svgElement("g", { transform: `translate(${node.x}, ${node.y})`, class: node.isReference ? "flow-node is-reference" : "flow-node", tabindex: canInspect ? 0 : -1, role: "group",
                "data-node-id": node.id, "data-zone-id": node.zoneId || "default", "data-appearance-id": node.appearanceId || "",
                "aria-label": `${node.name}, ${node.kind.replace("-", " ")}${origin}, ${changeLabels[node.diffStatus || "unchanged"]}`,
                "data-diff-status": node.diffStatus || "unchanged" });
            group.append(svgElement("title", {}, node.name + origin));
            let shape, missingIcon, statusChip;
            let missingIconHeight = 0;
            const chipY = 55 + FlowLayout.labelLines(node.name).length * 16 + 5;
            const positionChip = () => statusChip?.setAttribute("transform", `translate(-38,${chipY - 14 + missingIconHeight})`);
            if (["dataset", "recipe", "ml-recipe", "model", "agent-tool"].includes(node.kind)) {
                const dataset = node.kind === "dataset";
                const model = node.kind === "model";
                const iconKind = dataset ? "dataset" : model ? "model" : "recipe";
                const { type, filename, agent } = nodeIcon(node);
                if (agent) group.setAttribute("aria-label", `${node.name}, agent${origin}, ${changeLabels[node.diffStatus || "unchanged"]}`);
                const pluginRecipe = !dataset && !model && /^custom(?:code)?[_-]/i.test(type);
                shape = svgElement("g");
                shape.append(dataset ? svgElement("rect", { class: "dataset-icon-frame", x: -30, y: -30, width: 60, height: 60, rx: 4 }) :
                    model ? svgElement("polygon", { class: "model-icon-frame", points: "0,-36 36,0 0,36 -36,0" }) :
                        svgElement("circle", { class: "recipe-icon-frame", r: 29 }));
                const fallback = svgElement("text", { class: `${iconKind}-icon-fallback`, y: 8, visibility: "hidden" }, "?");
                const missing = svgElement("text", { class: `missing-${iconKind}-icon`, y: 55 + FlowLayout.labelLines(node.name).length * 16, visibility: "hidden" });
                const missingLines = [FlowLayout.labelLines(`Missing: ${type}`)[0], ...FlowLayout.labelLines(filename)];
                missingLines.forEach((line, index) => {
                    missing.append(svgElement("tspan", { x: 0, dy: index ? 14 : 0 }, line));
                });
                missing.append(svgElement("title", {}, `${dataset ? "Dataset" : model ? "Model" : "Recipe"} type: ${type}. Expected resource/icons/${filename}`));
                const iconSize = dataset ? 60 : model ? 72 : 58;
                const icon = svgElement("image", { x: -iconSize / 2, y: -iconSize / 2, width: iconSize, height: iconSize, preserveAspectRatio: "xMidYMid meet" });
                icon.addEventListener("error", () => {
                    icon.setAttribute("visibility", "hidden");
                    if (pluginRecipe) {
                        shape.children[0].setAttribute("class", "recipe-icon-frame plugin-recipe-fallback");
                        fallback.setAttribute("visibility", "hidden");
                        missing.setAttribute("visibility", "hidden");
                        missingIconHeight = 0;
                        positionChip();
                        return;
                    }
                    fallback.setAttribute("visibility", "visible");
                    missing.setAttribute("visibility", "visible");
                    missingIconHeight = missingLines.length * 14 + 5;
                    positionChip();
                });
                icon.addEventListener("load", () => {
                    if (pluginRecipe) shape.children[0].setAttribute("class", "recipe-icon-frame");
                    icon.setAttribute("visibility", "visible");
                    fallback.setAttribute("visibility", "hidden");
                    missing.setAttribute("visibility", "hidden");
                    missingIconHeight = 0;
                    positionChip();
                });
                icon.setAttribute("href", `../../resource/icons/${filename}${iconRevision ? `?v=${iconRevision}` : ""}`);
                shape.append(fallback, icon);
                missingIcon = missing;
            }
            else shape = svgElement("circle", { r: 29 });
            shape.setAttribute("class", `node-shape ${node.kind}`);
            group.append(shape);
            const label = svgElement("text", { class: "node-label", y: 55 });
            FlowLayout.labelLines(node.name).forEach((chunk, index) => label.append(svgElement("tspan", { x: 0, dy: index ? 16 : 0 }, chunk)));
            group.append(label);
            if (missingIcon) group.append(missingIcon);
            if (node.diffStatus && node.diffStatus !== "unchanged") {
                const badge = svgElement("g", { class: "diff-badge", transform: node.kind === "dataset" ? "translate(30,-28)" : "translate(36,-28)" });
                badge.append(svgElement("circle", { r: 11 }));
                badge.append(svgElement("text", { y: 4 }, { added: "+", deleted: "−", modified: "~" }[node.diffStatus]));
                group.append(badge);
                const chip = svgElement("g", { class: "diff-chip" });
                statusChip = chip;
                positionChip();
                chip.append(svgElement("rect", { width: 76, height: 21, rx: 5 }));
                chip.append(svgElement("text", { x: 38, y: 15 }, changeLabels[node.diffStatus]));
                group.append(chip);
            }
            if (canInspect) {
                const inspect = () => inspectObject(node.nodeId || node.id, group);
                group.addEventListener("click", () => { if (!panMoved) inspect(); });
                group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation?.(); inspect(); } });
            }
            flowContent.append(group);
        });
        const measured = (nodes.size || layout.zones.length) && typeof flowContent.getBBox === "function" ? flowContent.getBBox() : layout.bounds;
        currentFlowView = {
            signature, layout,
            bounds: { x: measured.x, y: measured.y, width: Math.max(1, measured.width), height: Math.max(1, measured.height) },
            x: 0, y: 0, zoom: 1
        };
        flowViews.set(baseline, currentFlowView);
        fitFlow();
    }

    /** Describe ready artifacts, including partial success when the other side fails. */
    function describeArtifacts(artifacts) {
        Object.values(artifacts).forEach((artifact) => {
            Object.values(sides).forEach((side) => {
                if (side.project !== artifact.sourceProjectKey) return;
                const commit = side.commits.find((entry) => entry.id === artifact.commitId);
                if (commit) commit.inRegistry = true;
            });
        });
        $("flow-preparation").textContent = ["baseline", "target"].filter((side) => artifacts[side]).map((side) => {
            const artifact = artifacts[side];
            return `${side === "baseline" ? "Baseline" : "Comparison"}: ${artifact.projectKey} · ${artifact.branchName} (${artifact.reused ? "reused" : "created"})`;
        }).join(" · ");
    }

    /** Prepare both revisions, compare their configurations, and render the union Flow. */
    async function showFlow() {
        if ($("object-inspector").open) $("object-inspector").close();
        const version = ++flowRequestVersion;
        const selected = selection();
        currentComparison = null;
        inspectedId = null;
        activeDiffTab = 'json';
        $("json-diff-rows").replaceChildren();
        $("recipe-code-rows").replaceChildren();
        $("flow-json-rows").replaceChildren();
        $("visual-inspector-panel").replaceChildren();
        $("json-comparison").hidden = true;
        $("comparison-summary").textContent = "";
        $("comparison-coverage-issues").replaceChildren();
        $("comparison-coverage").open = false;
        $("comparison-coverage").hidden = true;
        const sourceKey = selected.baseline.projectKey;
        $("comparison-form").hidden = true;
        $("selection-header").hidden = true;
        $("flow-screen").hidden = false;
        const project = projects.find((entry) => entry.key === sourceKey);
        $("flow-project").textContent = `${project ? project.name : sourceKey} (${sourceKey}) · ${selected.baseline.commitId.slice(0, 8)} → ${selected.target.projectKey} · ${selected.target.commitId.slice(0, 8)}`;
        $("flow-preparation").textContent = "";
        $("flow-title").focus();
        panGesture = null;
        currentFlowView = null;
        flowContent = null;
        $("flow-viewport").classList.remove("is-panning");
        $("flow-graph").replaceChildren();
        $("flow-status").classList.remove("error");
        $("flow-status").textContent = "Preparing comparison projects…";
        $("flow-spinner").hidden = false;
        $("retry-flow").hidden = true;
        $("refresh-flow").disabled = true;
        $("flow-viewport").setAttribute("aria-busy", "true");
        try {
            const started = await api("prepare-comparison", {}, selected);
            if (version !== flowRequestVersion) return;
            let prepared;
            while (version === flowRequestVersion) {
                const job = await api(`preparation/${encodeURIComponent(started.jobId)}`);
                if (version !== flowRequestVersion) return;
                describeArtifacts(job.artifacts || {});
                $("flow-status").textContent = job.message || "Preparing comparison projects…";
                if (job.state === "failed") throw new Error(job.error || "Comparison preparation failed. Retry to resume.");
                if (job.state === "ready") { prepared = job.artifacts; break; }
                await new Promise((resolve) => setTimeout(resolve, 750));
            }
            if (version !== flowRequestVersion) return;
            if (!prepared?.baseline?.archived || !prepared?.target?.archived) throw new Error("Both comparison projects must be ready before loading the Flow.");
            const baseline = prepared.baseline.projectKey;
            $("flow-status").textContent = "Comparing both prepared Flow configurations…";
            const comparison = await api("comparison", { baselineProjectKey: baseline, targetProjectKey: prepared.target.projectKey });
            const graph = comparison.graph;
            if (version !== flowRequestVersion) return;
            if (typeof FlowComparison === "undefined") throw new Error("The JSON comparison library could not be loaded. Install resource/flow-comparison.js and reload the webapp.");
            currentComparison = comparison;
            populateComparison(selected);
            const engine = getLayoutEngine();
            const measure = labelMeasurer();
            const signature = FlowLayout.signature(graph, measure);
            const viewKey = JSON.stringify([baseline, prepared.target.projectKey]);
            const previous = flowViews.get(viewKey);
            $("flow-status").textContent = "Arranging comparison Flow…";
            const layout = previous && previous.signature === signature ? previous.layout : await FlowLayout.layout(graph, engine, measure);
            if (version !== flowRequestVersion) return;
            renderFlow(graph, layout, signature, viewKey);
            $("flow-status").textContent = graph.nodes.length ? `${graph.nodes.length} items · ${graph.edges.length} connections${layout.zones.length ? ` · ${layout.zones.length} zones` : ""} · baseline → comparison` : "Both selected revisions have an empty Flow.";
        } catch (error) {
            if (version !== flowRequestVersion) return;
            $("flow-status").textContent = error.message;
            $("flow-status").classList.add("error");
            $("retry-flow").hidden = false;
        } finally {
            if (version === flowRequestVersion) {
                $("flow-spinner").hidden = true;
                $("flow-viewport").setAttribute("aria-busy", "false");
                $("refresh-flow").disabled = false;
            }
        }
    }

    /** Populate object choices and summary; JSON rendering remains lazy while folded. */
    function populateComparison(selected) {
        const counts = currentComparison.counts;
        $("comparison-summary").textContent = ["deleted", "modified", "added", "unchanged"].map((status) => `${counts[status]} ${changeLabels[status].toLowerCase()}`).join(" · ");
        if (currentComparison.zoneCounts) {
            const changedZones = ["added", "deleted", "modified"].reduce((sum, status) => sum + currentComparison.zoneCounts[status], 0);
            if (changedZones) $("comparison-summary").textContent += ` · ${changedZones} zone changes`;
        }
        const warnings = [...new Set([...(currentComparison.baseline.warnings || []), ...(currentComparison.target.warnings || [])])];
        $("comparison-coverage-issues").replaceChildren(...warnings.map((warning) => {
            const issue = document.createElement("li");
            issue.textContent = warning;
            return issue;
        }));
        $("comparison-coverage").hidden = !warnings.length;
        $("json-baseline-title").textContent = `Baseline · ${selected.baseline.projectKey} · ${selected.baseline.commitId.slice(0, 8)}`;
        $("json-target-title").textContent = `Comparison · ${selected.target.projectKey} · ${selected.target.commitId.slice(0, 8)}`;
        $("code-baseline-title").textContent = $("json-baseline-title").textContent;
        $("code-target-title").textContent = $("json-target-title").textContent;
        $("flow-json-baseline-title").textContent = $("json-baseline-title").textContent;
        $("flow-json-target-title").textContent = $("json-target-title").textContent;
        $("diff-object").replaceChildren(new Option("Both complete Flow structures", ""));
        currentComparison.graph.nodes.forEach((node) => $("diff-object").add(new Option(`${changeLabels[node.diffStatus]} · ${node.name}`, node.id)));
        $("json-comparison").hidden = false;
        if ($("json-comparison").open) renderFlowJsonDiff();
    }

    /** Open object comparisons above the Flow without expanding or moving the main page. */
    function inspectObject(id, opener = $("diff-object")) {
        if (!currentComparison) return;
        $("diff-object").value = id;
        renderJsonDiff();
        const node = currentComparison.graph.nodes.find((node) => node.id === id);
        $("inspector-title").textContent = id ? 'Compare object versions' : 'Compare Flow structures';
        $("inspector-object-name").textContent = node ? `${node.name} · ${node.subType === 'shaker' ? 'Prepare' : node.subType || node.kind}` : 'Both complete Flow structures';
        $("inspector-change-status").textContent = node ? changeLabels[node.diffStatus] || '' : '';
        $("inspector-change-status").setAttribute('data-diff-status', node?.diffStatus || 'unchanged');
        if (!$("object-inspector").open) {
            inspectorOpener = opener;
            $("object-inspector").showModal();
        }
    }

    /** Switch the inspector tab, keeping keyboard and panel visibility in sync. */
    function selectDiffTab(tab) {
        activeDiffTab = tab;
        renderJsonDiff();
    }

    /** Keep the complete Flow JSON available in the original foldable panel. */
    function renderFlowJsonDiff() {
        if (!currentComparison) return;
        renderDiffRows($("flow-json-rows"), FlowComparison.jsonRows(currentComparison.baseline.model, currentComparison.target.model));
    }

    function renderDiffRows(container, rows) {
        container.replaceChildren();
        rows.forEach((row) => {
            const tr = document.createElement("tr");
            tr.setAttribute("data-diff-status", row.status);
            ["left", "right"].forEach((side) => {
                const td = document.createElement("td");
                const number = document.createElement("span");
                number.className = "json-line-number";
                number.textContent = row[side + "Number"] || "";
                const code = document.createElement("pre");
                code.textContent = row[side] === null ? "" : row[side];
                td.append(number, code);
                tr.append(td);
            });
            container.append(tr);
        });
    }

    /** Render readable Split settings using text nodes; snapshots never become markup. */
    function renderSplitInspector(left, right, before, after) {
        const panel = $("visual-inspector-panel");
        panel.replaceChildren();
        const element = (tag, text, className) => {
            const node = document.createElement(tag);
            if (text !== undefined) node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        const headings = element('div', undefined, 'split-version-headings');
        ['json-baseline-title', 'json-target-title'].forEach((id) => headings.append(element('strong', $(id).textContent)));
        panel.append(headings);
        const availability = [left, right].map((model) => !model ? 'No Split recipe in this version.' : model.unavailable
            ? 'Split settings are unavailable. See JSON diff for the captured configuration.' : undefined);
        if (availability.some(Boolean)) {
            const states = element('div', undefined, 'split-version-states');
            availability.forEach((message) => states.append(element('p', message || 'Split recipe settings available.')));
            panel.append(states);
        }
        const section = (title, parent = panel) => {
            const node = element('section', undefined, 'split-section');
            node.append(element('h3', title));
            parent.append(node);
            return node;
        };
        const details = (title) => {
            const node = element('details', undefined, 'split-details');
            node.append(element('summary', title));
            panel.append(node);
            return node;
        };
        const value = (fields, other, key, side, text = fields?.[key]) => {
            const shown = text === undefined ? 'Not present' : String(text);
            const span = element('span', shown);
            if (fields?.[key] !== other?.[key]) {
                span.className = side ? 'split-added' : 'split-removed';
                span.setAttribute('aria-label', `${side ? 'New' : 'Previous'} ${key}: ${shown}`);
            }
            return span;
        };
        const comparisonTable = (parent, title) => {
            const table = element('table', undefined, 'split-pair');
            table.setAttribute('aria-label', title);
            const tbody = element('tbody');
            table.append(tbody); parent.append(table);
            return tbody;
        };
        const pair = (parent, title, a, b) => {
            const tbody = comparisonTable(parent, title || 'Split configuration');
            const tr = element('tr');
            [a, b].forEach((fields, side) => {
                const td = element('td');
                td.setAttribute('aria-label', side ? 'Comparison' : 'Baseline');
                if (!fields) td.append(element('span', 'Not present in this version', 'split-empty'));
                else {
                    if (title) td.append(element('strong', title, 'split-inline-title'));
                    const line = element('div', undefined, 'split-inline-fields');
                    Object.keys(fields).forEach((key) => {
                        const field = element('span', undefined, 'split-inline-field');
                        field.append(element('span', key + ': ', 'split-field-label'), value(fields, side ? a : b, key, side));
                        line.append(field);
                    });
                    td.append(line);
                }
                tr.append(td);
            });
            tbody.append(tr);
        };
        const readableLeft = left && !left.unavailable ? left : undefined;
        const readableRight = right && !right.unavailable ? right : undefined;
        const rules = section('Split rules');
        const strategy = (model) => model ? { 'Split on column': model.column ?? 'Not specified', 'Based on': model.mode === 'RANGE' ? 'Ranges' : model.mode ?? 'Not specified' } : undefined;
        pair(rules, undefined, strategy(readableLeft), strategy(readableRight));
        const isRange = (model) => model?.mode === 'RANGE';
        if ([readableLeft, readableRight].some((model) => model && !isRange(model))) {
            rules.append(element('p', 'This visual layout supports range splits. Other split strategies remain available in JSON diff and the full configuration below.', 'field-note'));
        }
        const aRanges = isRange(readableLeft) ? readableLeft.ranges : [], bRanges = isRange(readableRight) ? readableRight.ranges : [];
        if (isRange(readableLeft) || isRange(readableRight)) {
            const table = element('table', undefined, 'split-range-table');
            table.setAttribute('aria-label', 'Range destinations, Baseline and Comparison');
            const thead = element('thead'), headers = element('tr');
            ['Baseline', 'Comparison'].forEach((side) => ['From', 'To', 'Output'].forEach((label) => {
                const th = element('th', label);
                th.setAttribute('scope', 'col');
                th.setAttribute('aria-label', `${side} ${label}`);
                headers.append(th);
            }));
            thead.append(headers); table.append(thead);
            const tbody = element('tbody');
            const rangeRow = (a, b, title, remaining = false) => {
                const tr = element('tr');
                tr.setAttribute('aria-label', title);
                [a, b].forEach((fields, side) => {
                    const other = side ? a : b;
                    if (!fields) {
                        const td = element('td', 'Not present in this version', 'split-empty');
                        if (!side) td.className += ' split-side-end';
                        td.colSpan = 3; tr.append(td); return;
                    }
                    if (remaining || fields.Conditions !== undefined) {
                        const td = element('td'); td.colSpan = 2;
                        td.append(remaining ? element('span', 'Remaining values') : value(fields, other, 'Conditions', side));
                        tr.append(td);
                    } else {
                        ['From', 'To'].forEach((key) => {
                            const td = element('td');
                            const bound = key === 'From' ? 'Lower bound' : 'Upper bound';
                            const inclusive = fields[bound] === 'Inclusive';
                            const bracket = key === 'From' ? (inclusive ? '[' : '(') : (inclusive ? ']' : ')');
                            const mark = value(fields, other, bound, side, bracket);
                            mark.setAttribute('title', `${fields[bound]} ${key.toLowerCase()} bound`);
                            mark.setAttribute('aria-label', `${fields[bound]} ${key.toLowerCase()} bound`);
                            const number = value(fields, other, key, side);
                            if (key === 'From') td.append(mark, element('span', ' '), number);
                            else td.append(number, element('span', ' '), mark);
                            tr.append(td);
                        });
                    }
                    const output = element('td');
                    if (!side) output.className = 'split-side-end';
                    output.append(value(fields, other, 'Output', side));
                    if (fields.Filter || other?.Filter) {
                        output.append(element('span', ' · '), value(fields, other, 'Filter', side, fields.Filter || 'Enabled'));
                    }
                    tr.append(output);
                });
                tbody.append(tr);
            };
            for (let index = 0; index < Math.max(aRanges.length, bRanges.length); index++) {
                rangeRow(aRanges[index], bRanges[index], `Range ${index + 1}`);
            }
            rangeRow(isRange(readableLeft) ? readableLeft.remaining : undefined,
                isRange(readableRight) ? readableRight.remaining : undefined, 'Remaining values', true);
            table.append(tbody); rules.append(table);
            rules.append(element('p', '[ or ] includes the bound; ( or ) excludes it. Remaining values fall outside the configured ranges.', 'field-note split-bound-note'));
        }
        const filter = section('Filter before splitting');
        pair(filter, undefined, readableLeft?.filter, readableRight?.filter);
        const conditions = FlowComparison.splitConditionRows(readableLeft?.conditions, readableRight?.conditions);
        const conditionBody = comparisonTable(filter, 'Pre-filter conditions');
        conditions.forEach((row, index) => {
            const tr = element('tr');
            tr.setAttribute('aria-label', `Condition ${index + 1}`);
            [row.left, row.right].forEach((fields, side) => {
                const td = element('td');
                if (!fields) td.append(element('span', side ? 'Condition removed' : 'No corresponding condition', 'split-empty'));
                else {
                    if (!row.left || !row.right) td.append(element('span', !row.left ? 'Added ' : 'Removed ', 'split-condition-status'));
                    Object.keys(fields).forEach((key) => td.append(value(fields, side ? row.left : row.right, key, side), element('span', ' ')));
                }
                tr.append(td);
            });
            conditionBody.append(tr);
        });
        if (!conditions.length) filter.append(element('p', 'No rule conditions captured. See the full configuration for other filter expressions.', 'field-note'));
        const io = details('Input, outputs and write modes');
        const inputs = new Set([...(readableLeft?.inputs || []), ...(readableRight?.inputs || [])]);
        inputs.forEach((ref) => pair(io, 'Input dataset', readableLeft?.inputs.includes(ref) ? { Dataset: ref } : undefined,
            readableRight?.inputs.includes(ref) ? { Dataset: ref } : undefined));
        const outputs = new Set([...(readableLeft?.outputs || []), ...(readableRight?.outputs || [])].map((output) => output.Dataset));
        outputs.forEach((ref) => pair(io, 'Output dataset', readableLeft?.outputs.find((output) => output.Dataset === ref),
            readableRight?.outputs.find((output) => output.Dataset === ref)));
        if (!inputs.size && !outputs.size) io.append(element('p', 'No dataset references captured.'));
        const advanced = details('Full configuration and technical details');
        advanced.append(element('p', 'Includes engine settings, inactive split strategies, cached metadata and fields outside the visual layout.', 'field-note'));
        const scroll = element('div', undefined, 'json-diff-scroll');
        scroll.setAttribute('tabindex', '0');
        const table = element('table', undefined, 'json-diff');
        table.setAttribute('aria-label', 'Complete Split recipe JSON comparison');
        const thead = element('thead'), headerRow = element('tr');
        ['Baseline', 'Comparison'].forEach((title) => headerRow.append(element('th', title)));
        thead.append(headerRow);
        const tbody = element('tbody');
        FlowComparison.jsonRows(before, after).forEach((row) => {
            const tr = element('tr');
            tr.setAttribute('data-diff-status', row.status);
            ['left', 'right'].forEach((side) => {
                const td = element('td');
                td.append(element('pre', row[side] ?? ''));
                tr.append(td);
            });
            tbody.append(tr);
        });
        table.append(thead, tbody); scroll.append(table); advanced.append(scroll);
        const legend = element('p', undefined, 'split-legend');
        legend.append(element('span', 'Previous or removed', 'split-removed'), element('span', 'New or added', 'split-added'),
            element('span', 'Unchanged values stay neutral.'));
        panel.append(legend);
    }

    /** Shared paired-field panel for Prepare processors and model training sections. */
    function renderSettingsInspector(left, right, training = false) {
        const recipeName = training ? 'model training' : 'Prepare';
        const unit = training ? 'section' : 'step';
        const panel = $("visual-inspector-panel");
        panel.replaceChildren();
        const element = (tag, text, className) => {
            const node = document.createElement(tag);
            if (text !== undefined) node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        const readable = (model) => model && !model.unavailable;
        const unavailable = left?.unavailable || right?.unavailable;
        const rows = unavailable ? [] : FlowComparison.prepareStepRows(left?.steps, right?.steps);
        const counts = Object.fromEntries(['modified', 'deleted', 'added', 'unchanged'].map((status) => [status, rows.filter((row) => row.status === status).length]));
        const unavailableMessage = training ? 'Training changes unavailable: captured settings are missing.' : 'Step changes unavailable: a captured script is missing.';
        panel.append(element('p', unavailable ? unavailableMessage
            : `${counts.modified} modified · ${counts.deleted} removed · ${counts.added} added · ${counts.unchanged} unchanged ${unit}s`, 'prepare-summary'));
        panel.append(element('p', `Read-only configuration comparison. Expand a ${unit} to compare both versions.`, 'field-note'));
        const headings = element('div', undefined, 'split-version-headings');
        ['json-baseline-title', 'json-target-title'].forEach((id) => headings.append(element('strong', $(id).textContent)));
        panel.append(headings);
        const states = element('div', undefined, 'split-version-states');
        [left, right].forEach((model) => states.append(element('p', !model ? `No ${recipeName} recipe in this version.` : model.unavailable
            ? `${recipeName} settings are unavailable. See JSON diff for the captured configuration.` : model.steps.length ? '' : training ? 'No training settings in this version.' : 'No preparation steps in this version.')));
        if (!readable(left) || !readable(right) || !left.steps.length || !right.steps.length) panel.append(states);
        const show = (value) => value === undefined ? 'Not specified' : value === '' ? '(empty)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        const highlight = (side) => side ? 'split-added' : 'split-removed';
        // Structured values stay readable, and only changed leaves receive a diff highlight.
        const structuredValue = (value, other, side) => {
            if (value !== null && typeof value === 'object') {
                const array = Array.isArray(value), keys = Object.keys(value);
                if (!keys.length) return element('span', array ? 'No items' : 'No properties', JSON.stringify(value) !== JSON.stringify(other) ? highlight(side) : '');
                const list = element(array ? 'ol' : 'dl', undefined, array ? 'prepare-value-list' : 'prepare-value-properties');
                keys.forEach((key) => {
                    const item = element(array ? 'li' : 'div', undefined, array ? '' : 'prepare-value-property');
                    const previous = other !== null && typeof other === 'object' && Object.hasOwn(other, key) ? other[key] : undefined;
                    if (array) item.append(structuredValue(value[key], previous, side));
                    else {
                        item.append(element('dt', key));
                        const content = element('dd');
                        content.append(structuredValue(value[key], previous, side)); item.append(content);
                    }
                    list.append(item);
                });
                return list;
            }
            const changed = value !== other;
            const leaf = element('span', show(value), changed ? highlight(side) : '');
            if (changed) leaf.setAttribute('aria-label', `${side ? 'New' : 'Previous'} value: ${show(value)}`);
            return leaf;
        };
        const mappingField = (body, a, b) => {
            const fields = [a, b];
            const headings = element('div', undefined, 'prepare-field-pair');
            fields.forEach((field, side) => {
                const cell = element('div', undefined, 'prepare-field prepare-mapping-heading');
                cell.append(element('span', field?.label || fields[1 - side].label, 'prepare-field-label'));
                if (!field) cell.append(element('span', 'Not present in this version', 'split-empty'));
                else if (!field.mapping.entries.length) cell.append(element('span', 'No mappings', 'split-empty'));
                headings.append(cell);
            });
            body.append(headings);
            FlowComparison.prepareMappingRows(a?.mapping, b?.mapping).forEach((mapping) => {
                const pair = element('div', undefined, 'prepare-field-pair prepare-mapping-pair');
                [mapping.left, mapping.right].forEach((entry, side) => {
                    const cell = element('div', undefined, 'prepare-field prepare-mapping-cell');
                    cell.setAttribute('aria-label', side ? 'Comparison mapping' : 'Baseline mapping');
                    const other = side ? mapping.left : mapping.right;
                    if (!entry) cell.append(element('span', 'No corresponding mapping', 'split-empty'));
                    else {
                        const line = element('div', undefined, 'prepare-mapping-row');
                        const from = element('div', undefined, 'prepare-mapping-from');
                        const to = element('div', undefined, 'prepare-mapping-to');
                        from.setAttribute('aria-label', 'From'); to.setAttribute('aria-label', 'To');
                        from.append(structuredValue(entry.from, other?.from, side));
                        to.append(structuredValue(entry.to, other?.to, side));
                        const arrow = element('span', '→', 'prepare-mapping-arrow');
                        arrow.setAttribute('aria-hidden', 'true');
                        line.append(from, arrow, to); cell.append(line);
                        if (!other) cell.append(element('span', side ? 'Added' : 'Removed', 'prepare-mapping-status ' + highlight(side)));
                    }
                    pair.append(cell);
                });
                body.append(pair);
            });
        };
        rows.forEach((row) => {
            const details = element('details', undefined, 'prepare-step');
            details.open = row.status !== 'unchanged';
            details.setAttribute('data-diff-status', row.status);
            const summary = element('summary');
            const titles = element('span', undefined, 'prepare-step-titles');
            [row.left, row.right].forEach((step, side) => {
                const title = element('span', undefined, 'prepare-step-title');
                const other = side ? row.left : row.right;
                const text = step ? training ? step.title : `${step.index + 1}. ${step.title}` : row.status === 'added' ? `No corresponding ${unit} in Baseline` : `No corresponding ${unit} in Comparison`;
                title.append(element('strong', text, step && (!other || step.title !== other.title) ? (side ? 'split-added' : 'split-removed') : ''));
                if (step) {
                    const status = row.status === 'deleted' ? 'Removed' : changeLabels[row.status];
                    const badge = element('span', status, 'prepare-step-status');
                    badge.setAttribute('data-diff-status', row.status);
                    title.append(badge);
                }
                titles.append(title);
            });
            summary.append(titles); details.append(summary);
            const body = element('div', undefined, 'prepare-step-body');
            if ([row.left, row.right].some((step) => step && !step.known)) body.append(element('p', 'Processor settings are shown as captured parameters. Full configuration is available in JSON diff.', 'field-note'));
            // One grid row per field keeps long expressions/comments aligned across versions.
            const keys = [...new Set([...(row.left?.fields || []), ...(row.right?.fields || [])].map((field) => field.key))];
            keys.forEach((key, index) => {
                const a = row.left?.fields.find((field) => field.key === key);
                const b = row.right?.fields.find((field) => field.key === key);
                if ((a?.mapping || b?.mapping) && (!a || a.mapping) && (!b || b.mapping)) {
                    mappingField(body, a, b); return;
                }
                const pair = element('div', undefined, 'prepare-field-pair');
                [row.left, row.right].forEach((step, side) => {
                    const cell = element('div', undefined, 'prepare-field');
                    cell.setAttribute('aria-label', side ? 'Comparison' : 'Baseline');
                    const field = step?.fields.find((item) => item.key === key);
                    const otherStep = side ? row.left : row.right;
                    const other = otherStep?.fields.find((item) => item.key === key);
                    if (!step) {
                        if (!index) {
                            const label = training ? 'Section' : 'Step';
                            cell.append(element('p', `${label} ${side ? 'removed' : 'added'}. No corresponding ${unit} in this version.`, 'split-empty'));
                        }
                    } else if (!field) cell.append(element('span', training ? 'Not present in this section' : 'Not present in this processor', 'split-empty'));
                    else {
                        cell.append(element('span', field.label, 'prepare-field-label'));
                        const changed = !otherStep || !other || field.signature !== other.signature;
                        const structured = field.value !== null && typeof field.value === 'object';
                        const value = element('div', undefined, (field.rule ? 'prepare-if-rule' : structured ? 'prepare-structured-value' : 'prepare-field-value') + (changed && !structured ? (side ? ' split-added' : ' split-removed') : ''));
                        if (field.rule) {
                            field.rule.lines.forEach((line) => {
                                const paragraph = element('p', undefined, 'prepare-if-line');
                                paragraph.append(element('strong', line.label + ' '));
                                const previous = other?.rule?.lines.find((item) => item.key === line.key);
                                line.parts.forEach((part, index) => {
                                    const old = previous?.parts[index];
                                    const changedPart = !old || old.text !== part.text || old.role !== part.role;
                                    const token = element('span', part.text, 'prepare-if-' + part.role + (changedPart ? ' ' + highlight(side) : ''));
                                    if (changedPart) token.setAttribute('aria-label', `${side ? 'New' : 'Previous'} ${line.label}: ${part.text}`);
                                    paragraph.append(token);
                                });
                                value.append(paragraph);
                            });
                        } else if (typeof field.value === 'boolean') {
                            const checkbox = element('span', field.value ? '✓' : '', 'prepare-checkbox' + (field.value ? ' is-checked' : ''));
                            checkbox.setAttribute('aria-hidden', 'true');
                            value.append(checkbox, element('span', field.value ? 'On' : 'Off'));
                        } else if (structured) {
                            if (key === 'params.visualIfDesc' && step.type === 'VisualIfRule') value.append(element('p', 'This rule uses settings that require the captured structure below.', 'field-note'));
                            value.append(structuredValue(field.value, other?.value, side));
                        }
                        else value.append(element(key === 'params.expression' ? 'pre' : 'span', show(field.value)));
                        if (changed && !structured) value.setAttribute('aria-label', `${side ? 'New' : 'Previous'} ${field.label}: ${show(field.value)}`);
                        cell.append(value);
                    }
                    pair.append(cell);
                });
                body.append(pair);
            });
            if (!keys.length) body.append(element('p', 'No parameters captured for this processor.', 'field-note'));
            details.append(body); panel.append(details);
        });
        const legend = element('p', undefined, 'split-legend');
        legend.append(element('span', 'Previous or removed', 'split-removed'), element('span', 'New or added', 'split-added'), element('span', 'Unchanged values stay neutral.'));
        panel.append(legend);
        panel.append(element('p', training ? 'Captured recipe settings are shown here. Full configuration is available in JSON diff. Trained model binaries and execution results are not compared.' : 'Editor preview and layout state are omitted here. Engine, sampling, extra metadata and the full captured configuration remain available in JSON diff.', 'field-note'));
    }

    /** Copy the complete JSON value, excluding diff alignment and line numbers. */
    async function copyJson(side, wholeFlow) {
        if (!currentComparison) return;
        const prefix = `${wholeFlow ? 'flow-json' : 'json'}-${side}`;
        const status = $(prefix + '-copy-status');
        const model = currentComparison[side].model;
        const id = wholeFlow ? '' : $("diff-object").value;
        const value = id ? model.objects[id] : model;
        if (value === undefined) return;
        const text = JSON.stringify(value, null, 2);
        status.textContent = '';
        try {
            try {
                await navigator.clipboard.writeText(text);
            } catch (_) {
                // DSS may run on HTTP or in an iframe without Clipboard API access.
                const field = document.createElement('textarea');
                field.value = text;
                field.setAttribute('readonly', '');
                field.style.position = 'fixed';
                field.style.opacity = '0';
                const focused = document.activeElement;
                (wholeFlow ? $("json-comparison") : $("object-inspector")).append(field);
                try {
                    field.select();
                    if (!document.execCommand('copy')) throw new Error('Copy failed');
                } finally {
                    field.remove();
                    focused?.focus();
                }
            }
            status.textContent = 'Copied';
        } catch (_) {
            status.textContent = 'Copy failed. Please select and copy the JSON.';
        }
        setTimeout(() => { status.textContent = ''; }, 3000);
    }

    /** Render JSON or source lines as text so payloads cannot inject HTML. */
    function renderJsonDiff() {
        if (!currentComparison) return;
        const id = $("diff-object").value;
        const before = id ? currentComparison.baseline.model.objects[id] : currentComparison.baseline.model;
        const after = id ? currentComparison.target.model.objects[id] : currentComparison.target.model;
        ['baseline', 'target'].forEach((side) => {
            $(`json-${side}-copy`).disabled = (side === 'baseline' ? before : after) === undefined;
            $(`json-${side}-copy-status`).textContent = '';
        });
        const beforeCode = FlowComparison.recipeCode(before);
        const afterCode = FlowComparison.recipeCode(after);
        const hasCode = Boolean(id) && (beforeCode !== undefined || afterCode !== undefined);
        const beforeSplit = FlowComparison.splitRecipe(before), afterSplit = FlowComparison.splitRecipe(after);
        const hasSplit = Boolean(id) && (beforeSplit !== undefined || afterSplit !== undefined);
        const beforePrepare = FlowComparison.prepareRecipe(before), afterPrepare = FlowComparison.prepareRecipe(after);
        const hasPrepare = Boolean(id) && (beforePrepare !== undefined || afterPrepare !== undefined);
        const beforeTraining = FlowComparison.trainingRecipe(before), afterTraining = FlowComparison.trainingRecipe(after);
        const hasTraining = Boolean(id) && (beforeTraining !== undefined || afterTraining !== undefined);
        const hasVisual = hasSplit || hasPrepare || hasTraining;
        if (id !== inspectedId) activeDiffTab = hasVisual ? 'visual' : hasCode ? 'code' : 'json';
        if ((activeDiffTab === 'code' && !hasCode) || (activeDiffTab === 'visual' && !hasVisual)) activeDiffTab = 'json';
        inspectedId = id;
        $("recipe-code-tab").hidden = !hasCode;
        $("visual-inspector-tab").hidden = !hasVisual;
        const codeSelected = activeDiffTab === 'code';
        [['json-diff', activeDiffTab === 'json'], ['recipe-code', codeSelected], ['visual-inspector', activeDiffTab === 'visual']].forEach(([name, selected]) => {
            const tab = $(name + '-tab');
            tab.setAttribute('aria-selected', String(selected));
            tab.setAttribute('tabindex', selected ? '0' : '-1');
            $(name + '-panel').hidden = !selected;
        });
        $("diff-object-status").hidden = Boolean(id);
        $("diff-object-status").textContent = id ? "" : "Both complete canonical Flow structures. Generated project identities and automatic version timestamps are excluded.";
        if (activeDiffTab === 'visual') {
            if (hasTraining) renderSettingsInspector(beforeTraining, afterTraining, true);
            else if (hasPrepare) renderSettingsInspector(beforePrepare, afterPrepare);
            else renderSplitInspector(beforeSplit, afterSplit, before, after);
            return;
        }
        const container = $(codeSelected ? 'recipe-code-rows' : 'json-diff-rows');
        const rows = codeSelected ? FlowComparison.codeRows(beforeCode, afterCode) : FlowComparison.jsonRows(before, after);
        renderDiffRows(container, rows);
    }

    /** Return to the existing selection and ignore any pending Flow response. */
    function backToSelection() {
        if ($("object-inspector").open) $("object-inspector").close();
        ++flowRequestVersion;
        $("flow-spinner").hidden = true;
        panGesture = null;
        $("flow-viewport").classList.remove("is-panning");
        $("flow-screen").hidden = true;
        $("selection-header").hidden = false;
        $("comparison-form").hidden = false;
        Object.values(sides).forEach(renderCommits);
        updateReview(false);
        $("confirm-selection").focus();
    }

    /** Delete registered copies after explicit confirmation, preserving failed rows for retry. */
    async function cleanupProjects() {
        if (cleanupRunning) return;
        cleanupRunning = true;
        $("cleanup-confirmation").hidden = true;
        $("cleanup-projects").disabled = true;
        $("cleanup-status").classList.remove("error");
        $("cleanup-status").textContent = "Cleaning up registered comparison projects…";
        $("cleanup-failures").replaceChildren();
        $("cleanup-failures").hidden = true;
        updateReview(false);
        try {
            const started = await api("cleanup-projects", {}, { confirmed: true });
            let result;
            while (true) {
                const job = await api(`preparation/${encodeURIComponent(started.jobId)}`);
                $("cleanup-status").textContent = job.message || "Cleaning up comparison projects…";
                if (job.state === "failed") throw new Error(job.error || "Cleanup failed. Retry to resume.");
                if (job.state === "ready") { result = job.result; break; }
                await new Promise((resolve) => setTimeout(resolve, 750));
            }
            const failures = result.failures || [];
            $("cleanup-status").textContent = `${result.deletedProjects.length} projects deleted · ${result.alreadyMissingProjects.length} already absent · ${result.removedRecords} registry entries removed${failures.length ? ` · ${failures.length} entries retained; retry cleanup after resolving the failures.` : "."}`;
            $("cleanup-status").classList.toggle("error", failures.length > 0);
            failures.forEach((failure) => {
                const item = document.createElement("li");
                item.textContent = `${failure.projectKey || failure.recordKey}: ${failure.message}`;
                $("cleanup-failures").append(item);
            });
            $("cleanup-failures").hidden = !failures.length;
            flowViews.clear();
            await loadProjects();
        } catch (error) {
            $("cleanup-status").textContent = error.message;
            $("cleanup-status").classList.add("error");
        } finally {
            cleanupRunning = false;
            $("cleanup-projects").disabled = false;
            updateReview(false);
        }
    }

    /** Initialize side state, bind selection events, and load available projects. */
    function init() {
        ["base", "target"].forEach((id) => {
            const side = sides[id] = {
                id, project: "", selected: "", commits: [], next: null, version: 0,
                loading: false, error: false, select: $(`${id}-project`), search: $(`${id}-search`),
                list: $(`${id}-commits`), status: $(`${id}-status`), more: $(`${id}-more`)
            };
            side.select.addEventListener("change", () => {
                setProject(side, side.select.value);
                if (id === "base") syncMode();
            });
            side.search.addEventListener("input", () => renderCommits(side));
            side.more.addEventListener("click", () => loadCommits(side, side.commits.length > 0));
        });
        document.querySelectorAll('input[name="scope"]').forEach((radio) => radio.addEventListener("change", syncMode));
        $("tagged-commits-only").addEventListener("change", () => {
            Object.values(sides).forEach((side) => {
                selectEligibleCommit(side);
                renderCommits(side);
            });
            updateReview();
        });
        $("retry-projects").addEventListener("click", loadProjects);
        $("cleanup-projects").addEventListener("click", () => { $("cleanup-confirmation").hidden = false; $("confirm-cleanup").focus(); });
        $("cancel-cleanup").addEventListener("click", () => { $("cleanup-confirmation").hidden = true; $("cleanup-projects").focus(); });
        $("confirm-cleanup").addEventListener("click", cleanupProjects);
        $("retry-branches").addEventListener("click", loadBranches);
        $("back-to-selection").addEventListener("click", backToSelection);
        $("retry-flow").addEventListener("click", showFlow);
        $("refresh-flow").addEventListener("click", () => {
            if ($("refresh-flow").disabled) return;
            iconRevision = String(Date.now());
            showFlow();
        });
        ['baseline', 'target'].forEach((side) => {
            [false, true].forEach((wholeFlow) => {
                $(`${wholeFlow ? 'flow-json' : 'json'}-${side}-copy`).addEventListener('click', () => copyJson(side, wholeFlow));
            });
        });
        $("diff-object").addEventListener("change", () => inspectObject($("diff-object").value));
        $("open-inspector").addEventListener("click", () => inspectObject($("diff-object").value, $("open-inspector")));
        ['close-inspector', 'close-inspector-footer'].forEach((id) => $(id).addEventListener('click', () => $("object-inspector").close()));
        $("object-inspector").addEventListener('close', () => {
            if (!$("flow-screen").hidden && inspectorOpener?.isConnected !== false) inspectorOpener?.focus();
            inspectorOpener = null;
        });
        $("object-inspector").addEventListener('click', (event) => {
            const dialog = $("object-inspector"), bounds = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right
                    || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
        });
        const inspectorTabs = [['json-diff-tab', 'json'], ['recipe-code-tab', 'code'], ['visual-inspector-tab', 'visual']];
        inspectorTabs.forEach(([id, name]) => {
            $(id).addEventListener('click', () => selectDiffTab(name));
            $(id).addEventListener('keydown', (event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                const visible = inspectorTabs.filter(([tabId]) => !$(tabId).hidden);
                if (visible.length < 2) return;
                event.preventDefault();
                const index = visible.findIndex(([, tabName]) => tabName === activeDiffTab);
                const next = event.key === 'Home' ? visible[0] : event.key === 'End' ? visible.at(-1)
                    : visible[(index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
                selectDiffTab(next[1]);
                $(next[0]).focus();
            });
        });
        $("json-comparison").addEventListener("toggle", () => { if ($("json-comparison").open) renderFlowJsonDiff(); });
        $("flow-zoom-in").addEventListener("click", () => { if (currentFlowView) setFlowZoom(currentFlowView.zoom * 1.25); });
        $("flow-zoom-out").addEventListener("click", () => { if (currentFlowView) setFlowZoom(currentFlowView.zoom / 1.25); });
        $("flow-fit").addEventListener("click", () => fitFlow());
        bindFlowNavigation();
        $("comparison-form").addEventListener("submit", (event) => {
            event.preventDefault();
            if ($("confirm-selection").disabled) return;
            confirmed = true;
            updateReview(false);
            $("confirm-selection").disabled = true;
            // Notify integrations of the source selection before preparation begins.
            document.dispatchEvent(new CustomEvent("flowdiff:selection", { detail: selection() }));
            showFlow();
        });
        loadProjects();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
}());
