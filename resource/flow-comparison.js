/** Structural JSON alignment shared by the webapp and Node tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FlowComparison = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    /** Align sorted object keys and array indices, keeping missing-side rows blank. */
    function jsonRows(before, after) {
        const rows = [];
        let leftNumber = 0, rightNumber = 0;
        function emit(left, right) {
            rows.push({ left, right, leftNumber: left === null ? null : ++leftNumber,
                rightNumber: right === null ? null : ++rightNumber,
                status: left === null ? 'added' : right === null ? 'deleted' : left === right ? 'unchanged' : 'modified' });
        }
        function walk(left, right, indent = '', label = '', leftComma = '', rightComma = '') {
            const container = (value) => value !== null && typeof value === 'object';
            const leftContainer = left !== undefined && container(left);
            const rightContainer = right !== undefined && container(right);
            if ((leftContainer || rightContainer) && (left === undefined || right === undefined || Array.isArray(left) === Array.isArray(right))
                    && (left === undefined || leftContainer) && (right === undefined || rightContainer)) {
                const array = Array.isArray(left === undefined ? right : left);
                const sorter = array ? (a, b) => Number(a) - Number(b) : undefined;
                const leftKeys = (leftContainer ? Object.keys(left) : []).sort(sorter), rightKeys = (rightContainer ? Object.keys(right) : []).sort(sorter);
                const keys = [...new Set([...leftKeys, ...rightKeys])].sort(sorter);
                emit(left === undefined ? null : indent + label + (array ? '[' : '{'), right === undefined ? null : indent + label + (array ? '[' : '{'));
                const valueAt = (value, key) => value !== undefined && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
                keys.forEach((key) => walk(valueAt(left, key), valueAt(right, key),
                    indent + '  ', array ? '' : JSON.stringify(key) + ': ',
                    key !== leftKeys.at(-1) ? ',' : '', key !== rightKeys.at(-1) ? ',' : ''));
                emit(left === undefined ? null : indent + (array ? ']' : '}') + leftComma,
                    right === undefined ? null : indent + (array ? ']' : '}') + rightComma);
            } else {
                emit(left === undefined ? null : indent + label + JSON.stringify(left) + leftComma,
                    right === undefined ? null : indent + label + JSON.stringify(right) + rightComma);
            }
        }
        walk(before, after);
        return rows;
    }
    const codeTypes = new Set(['python', 'r', 'sql', 'shell', 'pyspark', 'spark_sql', 'sparkr', 'spark_scala']);

    /** Return source only for code recipes; JSON visual-recipe payloads are excluded. */
    function recipeCode(object) {
        const type = object?.config?.definition?.type || object?.subType;
        return object?.kind === 'recipe' && codeTypes.has(type) && typeof object.config?.payload === 'string'
            ? object.config.payload : undefined;
    }

    /** Align source lines by longest common subsequence, preserving source whitespace. */
    function codeRows(before, after) {
        const lines = (source) => source === undefined ? [] : source.replace(/\r\n?/g, '\n').split('\n');
        const left = lines(before), right = lines(after), rows = [];
        let a = 0, b = 0;
        function emit(l, r) {
            rows.push({ left: l, right: r, leftNumber: l === null ? null : ++a,
                rightNumber: r === null ? null : ++b,
                status: l === null ? 'added' : r === null ? 'deleted' : l === r ? 'unchanged' : 'modified' });
        }
        let start = 0, endLeft = left.length, endRight = right.length;
        while (start < endLeft && start < endRight && left[start] === right[start]) {
            emit(left[start], right[start]);
            start++;
        }
        while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight--; }
        const n = endLeft - start, m = endRight - start;
        // Bound memory/work for very large, wholly different scripts.
        if ((n + 1) * (m + 1) <= 4000000) {
            const width = m + 1, lcs = new Uint32Array((n + 1) * width);
            for (let i = n - 1; i >= 0; i--) {
                for (let j = m - 1; j >= 0; j--) {
                    lcs[i * width + j] = left[start + i] === right[start + j]
                        ? 1 + lcs[(i + 1) * width + j + 1]
                        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
                }
            }
            let i = 0, j = 0, removed = [], added = [];
            const flush = () => {
                for (let k = 0; k < Math.max(removed.length, added.length); k++) emit(removed[k] ?? null, added[k] ?? null);
                removed = []; added = [];
            };
            while (i < n || j < m) {
                if (i < n && j < m && left[start + i] === right[start + j]) {
                    flush(); emit(left[start + i++], right[start + j++]);
                } else if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
                    removed.push(left[start + i++]);
                } else added.push(right[start + j++]);
            }
            flush();
        } else {
            for (let k = 0; k < Math.max(n, m); k++) emit(k < n ? left[start + k] : null, k < m ? right[start + k] : null);
        }
        while (endLeft < left.length) emit(left[endLeft++], right[endRight++]);
        return rows;
    }
    const display = (value) => value === undefined ? 'Not specified' : typeof value === 'string' ? value
        : typeof value === 'number' ? value.toLocaleString('en-US', { maximumSignificantDigits: 21 }) : JSON.stringify(value);
    const stable = (value) => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

    /** Keep output identity separate from its position in each recipe definition. */
    function splitRecipe(object) {
        if (object?.kind !== 'recipe' || (object.config?.definition?.type || object.subType) !== 'split') return undefined;
        const payload = object.config?.payload;
        const definition = object.config?.definition || {};
        const outputs = definition.outputs?.main?.items || [];
        const destination = (index) => Number.isInteger(index) && index >= 0 && typeof outputs[index]?.ref === 'string'
            ? outputs[index].ref : `Unresolved output (${display(index)})`;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { unavailable: true };
        const operators = {
            'not empty string': 'is defined', 'empty string': 'is not defined',
            '>= [number]': '≥', '<= [number]': '≤', '> [number]': '>', '< [number]': '<',
            '== [number]': '=', '!= [number]': '≠'
        };
        const condition = (item) => {
            if (!item || typeof item !== 'object') return { Condition: display(item) };
            const operator = String(item.operator || '').replace(/\s+/g, ' ').trim();
            if (typeof item.input !== 'string' || !Object.hasOwn(operators, operator)) return { Condition: stable(item) };
            const fields = { Column: item.input, Operator: operators[operator] };
            if (operator.includes('[number]')) fields.Value = display(item.num);
            return fields;
        };
        const filter = payload.preFilter;
        const conditions = Array.isArray(filter?.uiData?.conditions) ? filter.uiData.conditions.map(condition) : [];
        const ranges = Array.isArray(payload.rangeSplits) ? payload.rangeSplits.map((item) => {
            const rule = item || {};
            const rules = rule.filter?.uiData?.conditions;
            const fields = {};
            const lower = rules?.[0], upper = rules?.[1];
            const op = (item) => String(item?.operator || '').replace(/\s+/g, ' ').trim();
            if (rules?.length === 2 && lower?.input === payload.column && upper?.input === payload.column && typeof payload.column === 'string'
                    && ['>= [number]', '> [number]'].includes(op(lower)) && ['< [number]', '<= [number]'].includes(op(upper))
                    && rule.filter.uiData.mode === '&&') {
                fields.From = display(lower.num);
                fields['Lower bound'] = op(lower).startsWith('>=') ? 'Inclusive' : 'Exclusive';
                fields.To = display(upper.num);
                fields['Upper bound'] = op(upper).startsWith('<=') ? 'Inclusive' : 'Exclusive';
            } else {
                fields.Conditions = Array.isArray(rules) ? rules.map((item) => Object.values(condition(item)).join(' ')).join(rule.filter?.uiData?.mode === '||' ? ' OR ' : ' AND ') || 'Not specified' : 'Not specified';
            }
            if (rule.filter?.enabled === false) fields.Filter = 'Disabled';
            fields.Output = destination(rule.outputIndex);
            return fields;
        }) : [];
        return {
            mode: payload.mode, column: payload.column, ranges,
            remaining: { Output: destination(payload.defaultOutputIndex) },
            filter: {
                Enabled: display(filter?.enabled),
                Match: filter?.uiData?.mode === '&&' ? 'ALL conditions (AND)' : filter?.uiData?.mode === '||' ? 'ANY condition (OR)' : display(filter?.uiData?.mode),
                'Distinct rows': filter?.distinct === false ? 'Duplicate rows allowed' : filter?.distinct === true ? 'Remove duplicate rows' : 'Not specified'
            },
            conditions,
            inputs: (definition.inputs?.main?.items || []).map((item) => item.ref),
            outputs: outputs.map((item) => ({ Dataset: item.ref, 'Write mode': item.appendMode === false ? 'Overwrite' : item.appendMode === true ? 'Append' : 'Not specified' }))
        };
    }

    /** Align readable conditions by content so inserting one does not modify all following rows. */
    function splitConditionRows(before = [], after = []) {
        return codeRows(before.length ? before.map(stable).join('\n') : undefined, after.length ? after.map(stable).join('\n') : undefined)
            .map((row) => ({ left: row.left === null ? undefined : JSON.parse(row.left), right: row.right === null ? undefined : JSON.parse(row.right) }));
    }
    const geoFields = {
        inCol: 'IP Column', outColPrefix: 'Prefix for generated output columns',
        extract_country: 'Extract country', extract_countrycode: 'Extract country code',
        extract_countrycode3: 'Extract country code (3 letters)', extract_region: 'Extract region',
        extract_city: 'Extract city', extract_postalcode: 'Extract postal code', extract_latlng: 'Extract lat/lng',
        extract_geopoint: 'Extract GeoPoint', extract_timezone: 'Extract timezone', extract_continentcode: 'Extract continent code'
    };
    const formulaFields = { column: 'Output column', expression: 'Expression', errorColumn: 'Error column' };
    const replacementFields = {
        columns: 'Columns', appliesTo: 'Apply to', appliesToPattern: 'Column pattern', output: 'Output column',
        useDatasetForMapping: 'Use dataset for mapping', mapping: 'Replacements', matching: 'Matching',
        normalization: 'Normalization', stopAfterFirstMatch: 'Stop after first match',
        mappingDatasetRef: 'Mapping dataset', mappingDatasetFromColumn: 'From column', mappingDatasetToColumn: 'To column'
    };
    const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

    /** Translate supported Visual If rules into ordered prose, falling back rather than guessing. */
    function prepareIfRule(value) {
        if (!record(value) || !record(value.ifThen)) return undefined;
        const token = (text, role = 'text') => ({ text: String(text), role });
        const literal = (v) => token(v === '' ? '""' : v, 'value');
        const text = (s) => token(s);
        const scalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
        const join = (items, separator) => items.flatMap((item, index) => index ? [text(separator), ...item] : item);
        function condition(item) {
            if (!record(item)) return undefined;
            if (Array.isArray(item.conditions)) {
                if (!['&&', '||'].includes(item.mode) || !item.conditions.length) return undefined;
                const parts = item.conditions.map(condition);
                if (parts.some((part) => !part)) return undefined;
                return [text('('), ...join(parts, item.mode === '&&' ? ' AND ' : ' OR '), text(')')];
            }
            if (typeof item.input !== 'string' || typeof item.operator !== 'string') return undefined;
            const op = item.operator.replace(/\s+/g, ' ').trim();
            const column = token(item.input, 'column');
            const comparison = /^(==|!=|>=|<=|>|<) \[(number|string|column)\](i?)$/.exec(op);
            if (comparison) {
                const key = { number: 'num', string: 'string', column: 'col' }[comparison[2]];
                if (!scalar(item[key])) return undefined;
                const operator = comparison[1] === '==' ? '=' : comparison[1];
                return [column, text(' ' + operator + ' '), comparison[2] === 'column' ? token(item[key], 'column') : literal(item[key]),
                    ...(comparison[3] ? [text(' (ignore case)')] : [])];
            }
            const unary = { true: 'is true', false: 'is false', 'not empty': 'is not empty', 'is empty': 'is empty',
                'not empty string': 'is not empty', 'empty string': 'is empty', 'empty array': 'is an empty array', 'not empty array': 'is not an empty array' };
            if (Object.hasOwn(unary, op)) return [column, text(' ' + unary[op])];
            const strings = { contains: 'contains', 'not contains': 'does not contain', regex: 'matches regex',
                'contains [string]i': 'contains (ignore case)', 'not contains [string]i': 'does not contain (ignore case)' };
            if (Object.hasOwn(strings, op) && typeof item.string === 'string') return [column, text(' ' + strings[op] + ' '), literal(item.string)];
            if (['>< [number]', '<> [number]'].includes(op) && scalar(item.num) && scalar(item.num2)) {
                return [column, text(op.startsWith('><') ? ' is between ' : ' is outside '), literal(item.num), text(' and '), literal(item.num2)];
            }
            return undefined;
        }
        function action(item) {
            if (!record(item) || typeof item.outputColumnName !== 'string') return undefined;
            const key = { ASSIGN_VALUE: 'value', ASSIGN_COLUMN: 'column', ASSIGN_FORMULA: 'formula' }[item.operator];
            if (!key || !scalar(item[key])) return undefined;
            return [text('('), token(item.outputColumnName, 'column'), text(' = '),
                ...(key === 'formula' ? [text('formula: ')] : []), key === 'column' ? token(item[key], 'column') : literal(item[key]), text(')')];
        }
        const lines = [];
        const actions = (items, label, path) => {
            if (!Array.isArray(items)) return false;
            if (!items.length) lines.push({ key: path, label, parts: [text('(No action)')] });
            for (let i = 0; i < items.length; i++) {
                const parts = action(items[i]);
                if (!parts) return false;
                lines.push({ key: `${path}.${i}`, label: i ? 'And' : label, parts });
            }
            return true;
        };
        const branch = (item, label, path) => {
            if (!record(item) || !record(item.filter) || item.filter.enabled === false) return false;
            const ui = item.filter.uiData;
            const parts = record(ui) && Array.isArray(ui.conditions) ? condition(ui)
                : typeof item.filter.expression === 'string' && item.filter.expression.trim()
                    ? [text('('), token(item.filter.expression, 'value'), text(')')] : undefined;
            if (!parts) return false;
            // A single condition is unwrapped by condition(); groups already carry their parentheses.
            lines.push({ key: path + '.condition', label, parts });
            return actions(item.actions, 'Then', path + '.actions');
        };
        if (!branch(value.ifThen, 'If', 'if')) return undefined;
        if (value.elseIfThens !== undefined && !Array.isArray(value.elseIfThens)) return undefined;
        for (let i = 0; i < (value.elseIfThens || []).length; i++) {
            if (!branch(value.elseIfThens[i], 'Else if', `elseIf.${i}`)) return undefined;
        }
        if (value.elseActions !== undefined && !actions(value.elseActions, 'Else', 'else.actions')) return undefined;
        return { lines };
    }

    /** Recognize mapping shapes without discarding extra attributes on unfamiliar records. */
    function prepareMapping(value, key = '') {
        const named = /^(mapping|mappings|renamings|replacements)$/.test(key.replace(/^params\./, ''));
        const pair = (item) => record(item) && Object.hasOwn(item, 'from') && Object.hasOwn(item, 'to') && Object.keys(item).length === 2;
        if (Array.isArray(value) && (value.length || named) && value.every(pair)) {
            return { entries: value, ordered: true };
        }
        if (pair(value)) return { entries: [value], ordered: true };
        if (named && record(value)) return { entries: Object.entries(value).map(([from, to]) => ({ from, to })), ordered: false };
        return undefined;
    }

    /** Pair ordered rules by exact content or an unambiguous source, preserving gaps and duplicates. */
    function prepareMappingRows(left, right) {
        if (left && right && !left.ordered && !right.ordered) {
            const a = new Map(left.entries.map((entry) => [entry.from, entry]));
            const b = new Map(right.entries.map((entry) => [entry.from, entry]));
            return [...new Set([...a.keys(), ...b.keys()])].map((key) => ({ left: a.get(key), right: b.get(key) }));
        }
        const steps = (mapping) => (mapping?.entries || []).map((entry, index) => ({
            index, identity: stable(entry.from), signature: stable(entry), entry
        }));
        return prepareStepRows(steps(left), steps(right)).map((row) => ({ left: row.left?.entry, right: row.right?.entry }));
    }

    /** Adapt Prepare (internally shaker) without including editor-only state in step changes. */
    function prepareRecipe(object) {
        if (object?.kind !== 'recipe' || !['shaker', 'prepare'].includes(object.config?.definition?.type || object.subType)) return undefined;
        const payload = object.config?.payload;
        if (!record(payload) || !Array.isArray(payload.steps)) return { unavailable: true, steps: [] };
        return { steps: payload.steps.map((source, index) => {
            const step = record(source) ? source : {};
            const params = record(step.params) ? step.params : {};
            const labels = step.type === 'GeoIPResolver' ? geoFields : step.type === 'CreateColumnWithGREL' ? formulaFields
                : step.type === 'FindReplace' ? replacementFields : step.type === 'ColumnRenamer' ? { renamings: 'Renamings' }
                : step.type === 'VisualIfRule' ? { visualIfDesc: 'Rule' } : {};
            const fields = [];
            const add = (key, label, value) => fields.push({ key, label, value, signature: stable(value), mapping: prepareMapping(value, key),
                rule: step.type === 'VisualIfRule' && key === 'params.visualIfDesc' ? prepareIfRule(value) : undefined });
            if (typeof step.disabled === 'boolean') add('enabled', 'Enabled', !step.disabled);
            else if (Object.hasOwn(step, 'disabled')) add('disabled', 'Disabled (captured value)', step.disabled);
            // Include known fields even when absent, so missing is never displayed as false or empty.
            for (const [key, label] of Object.entries(labels)) {
                if (labels === geoFields || labels === formulaFields || Object.hasOwn(params, key)) add('params.' + key, label, params[key]);
            }
            for (const key of Object.keys(params).sort()) {
                if (!Object.hasOwn(labels, key)) add('params.' + key, key, params[key]);
            }
            if (Object.hasOwn(step, 'comment')) add('comment', 'Comment', step.comment);
            const semantic = Object.fromEntries(Object.entries(step).filter(([key]) => !['id', 'stepId', 'preview', 'alwaysShowComment'].includes(key)));
            for (const key of Object.keys(semantic).sort()) {
                if (!['type', 'params', 'disabled', 'comment'].includes(key) && !(key === 'metaType' && step[key] === 'PROCESSOR')) add('step.' + key, key, step[key]);
            }
            if (!record(source)) add('raw', 'Captured step', source);
            else if (Object.hasOwn(step, 'params') && !record(step.params)) add('rawParams', 'Captured parameters', step.params);
            const title = step.type === 'GeoIPResolver' ? `Geo-locate IP in ${display(params.inCol)}`
                : step.type === 'CreateColumnWithGREL' ? `Create column ${display(params.column)}`
                : step.type === 'FindReplace' ? 'Find / Replace' : step.type === 'ColumnRenamer' ? 'Rename columns'
                : step.type === 'VisualIfRule' ? 'Visual If Rule' : step.type || 'Unknown processor';
            const identity = step.id ?? step.stepId;
            return { index, type: step.type, title, fields,
                identity: ['string', 'number'].includes(typeof identity) ? stable(identity) : undefined,
                signature: stable(record(source) ? semantic : source), known: Object.keys(labels).length > 0 };
        }) };
    }

    /** Adapt captured training settings into stable, aligned groups for the shared field renderer.
     * Implicit recipes may contain graph metadata only: never present that as ML settings.
     */
    function trainingRecipe(object) {
        const type = object?.config?.definition?.type || object?.subType;
        if (!['recipe', 'ml-recipe'].includes(object?.kind) || !['prediction_training', 'clustering_training'].includes(type)) return undefined;
        const config = object.config;
        if (object.coverage === 'graph-only' || object.coverage === 'external-reference' || !record(config?.payload)) {
            return { unavailable: true, steps: [] };
        }
        const titles = ['Training task', 'Input and output', 'Features', 'Algorithms', 'Training and evaluation', 'Runtime', 'Additional settings'];
        const groups = titles.map((title, index) => ({ index, title, type: 'training-section', identity: title, known: true, fields: [] }));
        const label = (key) => ({ targetVariable: 'Target variable', predictionType: 'Prediction type',
            modelId: 'Saved model ID', trainTestSplit: 'Train / test split', perFeature: 'Per-feature settings' }[key]
            || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase()));
        const category = (key) => /^(inputs|outputs)$/.test(key) ? 1
            : /feature|preprocess|role|column|weight/i.test(key) ? 2
            : /algorithm|hyperparam|modeling|gridsearch/i.test(key) ? 3
            : /train|test|split|evaluation|metric|sampling|crossvalid|kfold|seed/i.test(key) ? 4
            : /engine|runtime|container|spark|execution|codeenv|backend/i.test(key) ? 5
            : /target|prediction|task|modelid|sessionid|analysisid/i.test(key) ? 0 : 6;
        function add(group, path, caption, value) {
            // Flatten named settings so additions align by name; retain ordered lists intact.
            if (record(value) && Object.keys(value).length) {
                Object.keys(value).sort().forEach((key) => add(group, [...path, key], caption + ' / ' + label(key), value[key]));
            } else groups[group].fields.push({ key: JSON.stringify(path), label: caption, value, signature: stable(value) });
        }
        add(0, ['type'], 'Recipe type', type);
        function settings(source, path) {
            Object.keys(source).sort().forEach((key) => {
                if (key === 'type' && path[0] === 'definition') return;
                // DSS can nest these families in params; route the contained keys independently.
                if (['params', 'settings'].includes(key) && record(source[key])) settings(source[key], [...path, key]);
                else add(category(key), [...path, key], label(key), source[key]);
            });
        }
        settings(config.payload, ['payload']);
        if (record(config.definition)) settings(config.definition, ['definition']);
        return { steps: groups.filter((group) => group.fields.length).map((group) => ({ ...group,
            signature: stable(group.fields.map(({ key, value }) => ({ key, value }))) })) };
    }

    /** Sync stores its settings in the definition (its normal payload is an empty string).
     * Scoring stores output options in payload and runtime options in definition.params.
     * Both feed the same paired fields used by Prepare and training.
     */
    function syncRecipe(object, objects) { return executionRecipe(object, 'sync', objects); }
    function scoringRecipe(object, objects) { return executionRecipe(object, 'prediction_scoring', objects); }
    function executionRecipe(object, expectedType, objects = {}) {
        const type = object?.config?.definition?.type || object?.subType;
        if (!['recipe', 'ml-recipe'].includes(object?.kind) || type !== expectedType) return undefined;
        const scoring = type === 'prediction_scoring';
        const config = object.config, definition = config?.definition;
        if (['graph-only', 'external-reference'].includes(object.coverage) || !record(definition) || (scoring && !record(config.payload))) {
            return { unavailable: true, steps: [] };
        }
        const groups = new Map();
        const labels = {
            schemaMode: 'Schema handling', engineParams: 'Engine settings', maxThreads: 'Maximum threads',
            lowerCaseSchemaIfEngineRequiresIt: 'Lowercase schema when required by the engine',
            neverRecomputeExistingPartitions: 'Never recompute existing partitions', redispatchPartitioning: 'Redispatch partitioning',
            maxRunningActivities: 'Maximum concurrent activities', hashPropagationBehavior: 'Hash propagation',
            filterInputColumns: 'Keep only selected input columns', keptInputColumns: 'Input columns to keep (when filtering is on)',
            outputProbabilities: 'Output class probabilities', overrideModelSpecifiedThreshold: 'Override model classification threshold',
            forcedClassifierThreshold: 'Classification threshold (when override is on)',
            containerSelection: 'Container selection', containerMode: 'Container mode',
            gpuConfig: 'GPU settings', useGpu: 'Use GPU', gpuList: 'GPU devices', gpuAllowGrowth: 'Allow GPU memory growth',
            perGPUMemoryFraction: 'Memory fraction per GPU', disabledCapabilities: 'Disabled capabilities', sparkParams: 'Spark settings',
            pipelineAllowMerge: 'Allow pipeline merging', pipelineAllowStart: 'Allow pipeline start', sparkConf: 'Spark configuration',
            sparkPreparedDFStorageLevel: 'Prepared DataFrame storage level', sparkRepartitionNonHDFS: 'Repartition non-HDFS inputs'
        };
        const label = (key) => labels[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
        function add(title, path, caption, value) {
            if (record(value) && Object.keys(value).length) {
                Object.keys(value).sort().forEach((key) => add(title, [...path, key], key === 'params' ? caption : caption ? caption + ' / ' + label(key) : label(key), value[key]));
                return;
            }
            if (!groups.has(title)) groups.set(title, []);
            groups.get(title).push({ key: JSON.stringify(path), label: caption, value, signature: stable(value) });
        }
        // Use reference identity rather than array position for I/O; output reordering is neutral.
        for (const direction of ['inputs', 'outputs']) {
            const roles = definition[direction];
            if (!record(roles)) {
                add('Input and output', [direction], direction === 'inputs' ? 'Inputs' : 'Outputs', roles);
                continue;
            }
            Object.keys(roles).sort().forEach((role) => {
                const items = roles[role]?.items;
                if (!Array.isArray(items) || !items.every((item) => record(item) && typeof item.ref === 'string')
                        || new Set(items.map((item) => item.ref)).size !== items.length) {
                    add('Input and output', [direction, role], label(role), roles[role]); return;
                }
                const title = direction === 'outputs' ? 'Output dataset' : role === 'model' ? 'Saved model' : 'Input dataset';
                if (!items.length) add('Input and output', [direction, role], title, []);
                [...items].sort((a, b) => a.ref.localeCompare(b.ref)).forEach((item) => {
                    const path = [direction, role, item.ref];
                    const model = role === 'model' && Object.values(objects).find((candidate) => candidate.kind === 'model'
                        && (candidate.id === item.ref || candidate.id === JSON.stringify(['COMPUTABLE_SAVED_MODEL', item.ref])));
                    add('Input and output', [...path, 'ref'], title, model?.name ? `${model.name} (${item.ref})` : item.ref);
                    if (direction === 'outputs' && Object.hasOwn(item, 'appendMode')) {
                        add('Input and output', [...path, 'appendMode'], 'Write mode', typeof item.appendMode === 'boolean' ? item.appendMode ? 'Append' : 'Overwrite' : item.appendMode);
                    }
                    for (const key of Object.keys(item).sort()) {
                        if (key !== 'ref' && !(key === 'appendMode' && direction === 'outputs') && !(key === 'deps' && Array.isArray(item[key]) && !item[key].length)) {
                            add('Input and output', [...path, key], title + ' / ' + label(key), item[key]);
                        }
                    }
                });
            });
        }
        for (const key of ['neverRecomputeExistingPartitions', 'redispatchPartitioning', 'maxRunningActivities', 'hashPropagationBehavior', 'variables']) {
            if (Object.hasOwn(definition, key)) add('Build behavior', ['definition', key], label(key), definition[key]);
        }
        const params = definition.params;
        if (record(params)) Object.keys(params).sort().forEach((key) => {
            const title = /engine|container|spark|runtime/i.test(key) ? 'Runtime' : !scoring && key === 'schemaMode' ? 'Synchronization' : 'Additional settings';
            const value = key === 'schemaMode' ? ({ STRICT_SYNC: 'Strict schema synchronization', FREE_OUTPUT: 'Free output schema' }[params[key]] || params[key]) : params[key];
            add(title, ['definition', 'params', key], label(key), value);
        });
        else if (params !== undefined) add('Additional settings', ['definition', 'params'], 'Captured parameters', params);
        if (scoring) Object.keys(config.payload).sort().forEach((key) => {
            const title = ['filterInputColumns', 'keptInputColumns'].includes(key) ? 'Input columns'
                : ['outputProbabilities', 'overrideModelSpecifiedThreshold', 'forcedClassifierThreshold'].includes(key) ? 'Prediction output'
                : key === 'gpuConfig' ? 'GPU' : key === 'sparkParams' ? 'Runtime' : 'Additional settings';
            add(title, ['payload', key], label(key), config.payload[key]);
        });
        else if (config.payload !== undefined && config.payload !== '') add('Additional settings', ['payload'], 'Captured payload', config.payload);
        const order = ['Input and output', 'Synchronization', 'Input columns', 'Prediction output', 'GPU', 'Runtime', 'Build behavior', 'Additional settings'];
        return { steps: order.filter((title) => groups.has(title)).map((title, index) => ({
            index, title, type: 'recipe-section', identity: title, known: true, fields: groups.get(title),
            signature: stable(groups.get(title).map(({ key, value }) => ({ key, value })))
        })) };
    }

    /** Sequence alignment: exact steps/unique IDs first, then unambiguous same-type edits within gaps.
     * Reordered steps can appear as removed/added; repeated ambiguous edits are never guessed.
     * Sparse LIS keeps memory bounded even for large Prepare scripts.
     */
    function prepareStepRows(before = [], after = []) {
        const counts = (items, key) => {
            const result = new Map();
            items.forEach((item) => { const value = key(item); result.set(value, (result.get(value) || 0) + 1); });
            return result;
        };
        const idsLeft = counts(before, (s) => s.identity), idsRight = counts(after, (s) => s.identity);
        const token = (s) => s.identity !== undefined && idsLeft.get(s.identity) === 1 && idsRight.get(s.identity) === 1
            ? 'id:' + s.identity : 'step:' + s.signature;
        // Hunt-Szymanski LCS, bounded for pathological repeated identical processors.
        function anchors(left, right, key, accepts = () => true) {
            const positions = new Map();
            right.forEach((s, j) => { const k = key(s); if (!positions.has(k)) positions.set(k, []); positions.get(k).push(j); });
            const tails = [], links = [];
            let work = 0;
            for (let i = 0; i < left.length; i++) {
                const matches = positions.get(key(left[i])) || [];
                if ((work += matches.length) > 1000000) break;
                for (let k = matches.length - 1; k >= 0; k--) {
                    const j = matches[k];
                    if (!accepts(left[i], right[j])) continue;
                    let low = 0, high = tails.length;
                    while (low < high) { const mid = (low + high) >>> 1; if (tails[mid].j < j) low = mid + 1; else high = mid; }
                    const node = { i, j, previous: low ? tails[low - 1] : undefined };
                    tails[low] = node;
                }
            }
            for (let node = tails.at(-1); node; node = node.previous) links.push([node.i, node.j]);
            return links.reverse();
        }
        const rows = [];
        const emit = (left, right) => rows.push({ left, right, status: !left ? 'added' : !right ? 'deleted'
            : left.signature === right.signature ? 'unchanged' : 'modified' });
        function gap(left, right) {
            const a = counts(left, (s) => s.type), b = counts(right, (s) => s.type);
            const matches = anchors(left, right, (s) => s.type, (l, r) => l.type !== undefined && a.get(l.type) === 1 && b.get(r.type) === 1
                && (l.identity === undefined || r.identity === undefined || l.identity === r.identity));
            let i = 0, j = 0;
            for (const [x, y] of [...matches, [left.length, right.length]]) {
                while (i < x) emit(left[i++], undefined);
                while (j < y) emit(undefined, right[j++]);
                if (i < left.length && j < right.length) emit(left[i++], right[j++]);
            }
        }
        const compatible = (l, r) => l.identity === undefined || r.identity === undefined || l.identity === r.identity;
        let start = 0, endLeft = before.length, endRight = after.length;
        while (start < endLeft && start < endRight && token(before[start]) === token(after[start]) && compatible(before[start], after[start])) {
            emit(before[start], after[start]); start++;
        }
        while (endLeft > start && endRight > start && token(before[endLeft - 1]) === token(after[endRight - 1]) && compatible(before[endLeft - 1], after[endRight - 1])) {
            endLeft--; endRight--;
        }
        const suffixLeft = before.slice(endLeft), suffixRight = after.slice(endRight);
        before = before.slice(start, endLeft); after = after.slice(start, endRight);
        let i = 0, j = 0;
        for (const [x, y] of [...anchors(before, after, token, compatible), [before.length, after.length]]) {
            gap(before.slice(i, x), after.slice(j, y));
            if (x < before.length && y < after.length) emit(before[x], after[y]);
            i = x + 1; j = y + 1;
        }
        suffixLeft.forEach((step, index) => emit(step, suffixRight[index]));
        return rows;
    }
    return { syncRecipe, scoringRecipe, trainingRecipe, jsonRows, codeRows, recipeCode, splitRecipe, splitConditionRows, prepareRecipe, prepareStepRows, prepareMapping, prepareMappingRows, prepareIfRule };
}));
