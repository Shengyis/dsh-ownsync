/* ---------- 样式 ---------- */
const STYLE = `
.os-wrap{display:flex;flex-direction:column;gap:14px;padding:16px}
.os-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid transparent;font-size:12px;line-height:1.2;max-width:100%}
.os-dot{flex:none;width:6px;height:6px;border-radius:50%;background:#16a34a}
.os-pill-warn .os-dot{background:#d97706}
.os-pill-err .os-dot{background:#dc2626}
.os-pill-muted .os-dot{background:#94a3b8}
.os-pill-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
.os-pill-warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
.os-pill-err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4)}
.os-pill-muted{background:rgba(100,116,139,.12);border-color:rgba(100,116,139,.3)}
.os-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d7dce3);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-family:inherit;font-size:13px;line-height:1.2;cursor:pointer;white-space:nowrap}
.os-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
.os-btn:disabled{opacity:.45;cursor:not-allowed}
.os-btn:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:1px}
.os-btn-primary{background:var(--dsw-alias-accent,#2563eb);border-color:var(--dsw-alias-accent,#2563eb);color:#fff}
.os-btn-primary:hover:not(:disabled){background:var(--dsw-alias-accent,#2563eb);filter:brightness(1.06)}
.os-btn-danger{background:#dc2626;border-color:#dc2626;color:#fff}
.os-btn-danger:hover:not(:disabled){background:#dc2626;filter:brightness(1.06)}
.os-btn-check{background:#f0b400;border-color:#f0b400;color:#3b2f00}
.os-btn-check:hover:not(:disabled){background:#f0b400;filter:brightness(1.06)}
.os-note{padding:10px 12px;border-radius:8px;border:1px solid transparent;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.os-note-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
.os-note-warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
.os-note-err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4)}
.os-list{margin:4px 0 0;padding-left:18px;font-size:12px;line-height:1.7;max-height:140px;overflow:auto;overflow-wrap:anywhere}
.os-confirm{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;border:1px solid rgba(245,158,11,.45);background:rgba(245,158,11,.1)}
.os-confirm-text{font-size:13px;line-height:1.6}
.os-confirm-actions{display:flex;gap:8px}
.os-settings-body{display:flex;flex-direction:column;gap:10px}
.os-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.os-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}
.os-field-inline{display:flex;align-items:center;gap:8px}
.os-field-inline .os-field-label{flex:1 1 auto;min-width:0}
.os-field-inline .os-btn{box-sizing:border-box;height:24px;padding:0 10px;font-size:12px;flex:0 0 auto}
.os-input-num{box-sizing:border-box;flex:0 0 64px;width:64px;text-align:right}
.os-input-branch{box-sizing:border-box;flex:0 0 64px;width:64px}
.os-field-unit{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);flex:0 0 auto}
.os-input{box-sizing:border-box;width:100%;height:24px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d7dce3);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-family:inherit;font-size:13px;line-height:22px}
.os-input:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:1px}
.os-input-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.os-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9ca3af);overflow-wrap:anywhere}
.os-foot{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.os-foot:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.os-foot-on{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.os-foot:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:2px}
.os-foot-label{font-size:13px;white-space:nowrap}
.os-nav{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;font-size:15px;line-height:1}
.os-dock{display:flex;flex-direction:column;gap:6px;flex:1 1 100%;min-width:0;padding:0 2px}
.os-dock-card{display:flex;flex-direction:column;gap:5px;padding:8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#e2e6ec);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.os-dock-row{display:flex;min-width:0}
.os-dock .os-pill{font-size:11px;padding:3px 8px}
.os-pill-button{cursor:pointer;border:0;font:inherit;text-align:left}
.os-caret{margin-left:2px;font-size:9px;opacity:.75}
.os-dock-changes{display:flex;flex-direction:column;gap:2px;margin-top:2px;padding:6px 8px;border-radius:6px;border:1px solid transparent;font-size:11px;line-height:1.5;max-height:120px;overflow:auto}
.os-dock-changes-warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
.os-dock-changes-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
.os-dock-changes ul{margin:2px 0 0;padding-left:14px}
.os-dock-paths{overflow-wrap:anywhere}
.os-dock-more{opacity:.75}
.os-dock-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums;min-width:0}
.os-dock-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.os-dock-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:2px}
.os-dock-actions .os-btn{box-sizing:border-box;height:26px;padding:0 8px;font-size:12px;border-radius:7px}
.os-dock .os-foot{justify-content:center;align-self:flex-start;width:fit-content;min-width:0}
.os-dock-note{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;border:1px solid transparent;font-size:11px;line-height:1.5;overflow-wrap:anywhere;max-height:7em;overflow:auto}
.os-dock-note .os-link{align-self:flex-start;font-size:11px;padding:0}
.os-popover{position:fixed;z-index:900;display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 16px 44px rgba(15,23,42,.2);pointer-events:auto}
.os-popover-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 4px;background:transparent}
.os-popover-title{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#6b7280)}
.os-popover-close{width:26px;height:26px;line-height:1;border:0;border-radius:6px;background:transparent;color:inherit;font-size:18px;cursor:pointer}
.os-popover-close:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.os-popover-body{flex:1;min-height:0;overflow:auto}
.os-popover .os-wrap{padding:8px 16px 16px}
.os-section{display:block}
.os-lock{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.5)}
.os-lock-card{display:flex;flex-direction:column;gap:12px;width:min(360px,100%);padding:20px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 24px 64px rgba(0,0,0,.3);outline:none}
.os-lock-title{font-size:15px;font-weight:600}
.os-lock-text{margin:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280)}
.os-lock-actions{display:flex;gap:8px;justify-content:flex-end}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  try {
    const element = document.createElement('style');
    element.setAttribute('data-dsh-ownsync', '');
    element.textContent = STYLE;
    document.head.appendChild(element);
  } catch {
    /* 样式注入失败不影响功能 */
  }
}
