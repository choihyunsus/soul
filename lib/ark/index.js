// n2-ark — AI Safety (Soul embedded). The Last Shield.
const path = require('path');
const { loadRules, parse } = require('./parser');
const { SafetyGate } = require('./gate');
const { AuditLogger } = require('./audit');

/**
 * Creates an n2-ark instance for Soul integration.
 * Ark is UNCONDITIONAL — no enabled toggle. This is by design.
 *
 * @param {object} options
 * @param {string} options.rulesDir — Directory containing .n2 rule files
 * @param {string} options.auditDir — Audit log directory
 * @param {boolean} options.strictMode — Block unknown actions (default: false)
 * @param {boolean} options.auditEnabled — Enable audit logging (default: true)
 * @param {boolean} options.auditPasses — Log passed actions too (default: false)
 * @returns {{ gate: SafetyGate, audit: AuditLogger, check: function, approve: function }}
 */
function createArk(options = {}) {
    const rulesDir = options.rulesDir || path.join(__dirname, '..', '..', 'rules');
    const auditDir = options.auditDir || path.join(__dirname, '..', '..', 'data', 'ark-audit');

    // Load and parse all .n2 rule files
    const rules = loadRules(rulesDir);

    // Create audit logger
    const audit = new AuditLogger({
        dir: auditDir,
        enabled: options.auditEnabled !== false,
        logPasses: options.auditPasses || false,
    });

    // Create safety gate with audit hooks
    const gate = new SafetyGate(rules, {
        strictMode: options.strictMode || false,
        onBlock: (result) => audit.log(result, { type: result.type }),
        onPass: (result) => audit.log(result, { type: result.type }),
    });

    // Log loaded rules summary
    const summary = gate.summary();
    console.error(`[n2-ark] Loaded: ${summary.contracts} contracts, ${summary.blacklists} blacklists (${summary.patterns} patterns), ${summary.gates} gates`);

    return {
        gate,
        audit,

        /**
         * Check an action against all safety rules.
         * @param {string} name — Action name
         * @param {string} content — Action content/arguments
         * @param {string} type — Action type (default: 'tool_call')
         * @returns {{ allowed: boolean, reason?: string }}
         */
        check(name, content = '', type = 'tool_call') {
            return gate.check({ name, content, type });
        },

        /**
         * Grant approval for a blocked action.
         * @param {string} ruleName — Rule that blocked
         * @param {string} actionName — Action to approve
         */
        approve(ruleName, actionName) {
            gate.approve(ruleName, actionName);
        },

        /**
         * Load additional rules from a string.
         * Self-protection: rejects rules that overwrite protect_layer rules.
         * @param {string} source — .n2 rule content
         */
        loadString(source) {
            const parsed = parse(source);

            // Self-protection: reject rules that overwrite protect_layer rules
            const protectedNames = Object.keys(gate.blacklists).filter(n => n.startsWith('protect_'));
            for (const name of Object.keys(parsed.blacklists)) {
                if (protectedNames.includes(name)) {
                    console.error(`[n2-ark] BLOCKED: Cannot overwrite self-protection rule '${name}'`);
                    delete parsed.blacklists[name];
                }
            }

            Object.assign(gate.contracts, parsed.contracts);
            Object.assign(gate.blacklists, parsed.blacklists);
            Object.assign(gate.gates, parsed.gates);

            // Reset state machines for new contracts
            for (const [name, contract] of Object.entries(parsed.contracts)) {
                gate._states[name] = contract.initialState;
            }
        },

        /** Get summary of loaded rules. */
        summary() { return gate.summary(); },

        /** Reset all state machines. */
        reset() { gate.reset(); },

        /** Get audit statistics. */
        stats(days = 7) { return audit.stats(days); },

        /** Shutdown — flush audit logs. */
        close() { audit.close(); },
    };
}

module.exports = { createArk, SafetyGate, AuditLogger, loadRules, parse };
