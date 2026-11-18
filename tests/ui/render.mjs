// Turns the mock widget tree (gi.mjs) into an HTML page styled by the real extension/stylesheet.css, as close to
// St's layout rules as a browser gets: BoxLayout = flexbox, x/y_expand = flex grow, plain St.Widget = fixed positions.
// It is an approximation for looking at layout and colour, not a pixel-exact copy of GNOME Shell.
import fs from 'fs';
import path from 'path';

const THEME_GLYPHS = {
    'media-playback-start-symbolic': '▶', 'media-playback-pause-symbolic': '❚❚', 'window-close-symbolic': '✕',
    'user-trash-symbolic': '🗑', 'go-previous-symbolic': '‹', 'go-next-symbolic': '›', 'edit-clear-symbolic': '⌫',
    'preferences-system-symbolic': '⚙', 'view-refresh-symbolic': '↻', 'x-office-calendar-symbolic': '▦',
    'pan-down-symbolic': '▾', 'pan-up-symbolic': '▴',
};

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function css(stylesheet) {
    return stylesheet
        .replace(/(^|[;{\s])spacing:/g, '$1gap:')
        .replace(/icon-size:\s*([0-9.]+px)/g, '--icon-size: $1')
        .replace(/:checked/g, '.pc-checked').replace(/:focus/g, '.pc-focus').replace(/:error/g, '.pc-error')
        .replace(/StLabel\.hint-text/g, '.hint-text').replace(/(\s)BoxLayout/g, '$1.BoxLayout');
}

function iconHtml(a, iconDir) {
    const g = a.gicon;
    const cls = esc(a.style_class || 'qb-icon');
    if (g?.file?.path) {
        const svg = fs.readFileSync(g.file.path, 'utf8');
        const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        return `<span class="icon ${cls}" style="-webkit-mask:url(${url}) center/contain no-repeat;mask:url(${url}) center/contain no-repeat"></span>`;
    }
    void iconDir;
    return `<span class="icon glyph ${cls}">${esc(THEME_GLYPHS[g?.name] ?? '•')}</span>`;
}

function childStyle(c, parentIsRow, parentKind) {
    const s = [];
    if (parentKind === 'box') {
        if (parentIsRow) {
            if (c.x_expand)
                s.push('flex:1 1 0', 'min-width:0');
            else
                s.push('flex:0 0 auto');
            const ya = c.y_align;
            if (ya === 2)
                s.push('align-self:center');
            else if (ya === 1)
                s.push('align-self:flex-start');
            else if (ya === 3)
                s.push('align-self:flex-end');
        } else {
            if (c.y_expand)
                s.push('flex:1 1 0', 'min-height:0');
            else
                s.push('flex:0 0 auto');
            const xa = c.x_align;
            if (xa === 2)
                s.push('align-self:center');
            else if (xa === 1)
                s.push('align-self:flex-start');
            else if (xa === 3)
                s.push('align-self:flex-end');
        }
    }
    return s;
}

function node(a, ctx, parentIsRow = true, parentKind = 'box') {
    if (!a || a.visible === false || a.destroyed)
        return '';
    const kind = a.kind;
    const classes = [a.style_class, ...[...a._pseudo].map(p => `pc-${p}`)];
    const st = childStyle(a, parentIsRow, parentKind);
    if (a._fixedW)
        st.push(`width:${a._fixedW}px`, 'flex-shrink:0');
    else if (a.style_class === 'qb-ring' && a.width)  // sized in its constructor (St takes width/height there too)
        st.push(`width:${a.width}px`, `height:${a.height}px`, 'flex-shrink:0');
    if (a._fixedH)
        st.push(`height:${a._fixedH}px`);
    if (a._abs || parentKind === 'fixed')
        st.push('position:absolute', `left:${a.x}px`, `top:${a.y}px`);
    if (a._grid)
        st.push(`grid-column:${a._grid.col + 1}`, `grid-row:${a._grid.row + 1}`, 'min-height:0', 'min-width:0');
    if (a._style)
        st.push(a._style.replace(/;$/, ''));
    const kids = (isRow, k) => a.children.map(c => node(c, ctx, isRow, k)).join('');

    switch (kind) {
    case 'Label': {
        const wrap = a.clutter_text?.line_wrap;
        classes.push('lbl', wrap ? 'wrap' : 'nowrap');
        return `<span class="${esc(classes.join(' '))}" style="${st.join(';')}">${esc(a.text)}</span>`;
    }
    case 'DrawingArea': {  // the level ring: drawn with cairo in the shell, a conic gradient here
        const w = a.parent ?? {};
        const deg = Math.round(360 * Math.min(1, w._ringFrac ?? 0));
        st.push('border-radius:50%', 'position:absolute', 'inset:0', `background:conic-gradient(#f6d32d ${deg}deg, rgba(255,255,255,0.16) 0)`,
            '-webkit-mask:radial-gradient(circle, transparent 58%, #000 60%)', 'mask:radial-gradient(circle, transparent 58%, #000 60%)');
        return `<div style="${st.join(';')}"></div><div style="position:absolute;inset:3px;border-radius:50%;background:rgba(246,211,45,0.14)"></div>`;
    }
    case 'Icon':
        return iconHtml(a, ctx.iconDir).replace('style="', `style="${st.join(';')};`);
    case 'Entry': {
        const t = a.text ? `<span class="nowrap">${esc(a.text)}</span>` : `<span class="hint-text nowrap">${esc(a.hint_text)}</span>`;
        return `<div class="${esc(classes.join(' '))} entry" style="${st.join(';')}">${t}</div>`;
    }
    case 'Button': {
        const inner = a.label != null && !a.children.length ? `<span class="nowrap">${esc(a.label)}</span>` : kids(true, 'box');
        return `<div class="${esc(classes.join(' '))} btn" style="${st.join(';')}">${inner}</div>`;
    }
    case 'BoxLayout': {
        const isRow = !(a.orientation === 1 || a.vertical === true);
        classes.push('BoxLayout');
        st.push('display:flex', `flex-direction:${isRow ? 'row' : 'column'}`, 'box-sizing:border-box');
        return `<div class="${esc(classes.join(' '))}" style="${st.join(';')}">${kids(isRow, 'box')}</div>`;
    }
    case 'ScrollView':
        st.push('display:flex', 'flex-direction:column', 'overflow:hidden');
        return `<div class="${esc(classes.join(' '))}" style="${st.join(';')}">${kids(false, 'box')}</div>`;
    case 'Bin':
        st.push('display:flex', 'align-items:center', 'justify-content:center', 'box-sizing:border-box');
        return `<div class="${esc(classes.join(' '))}" style="${st.join(';')}">${kids(true, 'box')}</div>`;
    default: { // St.Widget
        const lm = a.layout_manager;
        if (lm?.constructor?.name === 'GridLayout') {
            st.push('display:grid', 'grid-template-columns:1fr 1fr', 'grid-template-rows:1fr 1fr', `gap:${lm.row_spacing}px ${lm.column_spacing}px`);
            return `<div class="${esc(classes.join(' '))}" style="${st.join(';')}">${kids(true, 'grid')}</div>`;
        }
        if (lm?.constructor?.name === 'BinLayout') {
            st.push('display:flex', 'justify-content:center', 'align-items:' + (a.style_class === 'qb-ring' ? 'center' : 'flex-end'), 'position:relative');
            return `<div class="${esc(classes.join(' '))}" style="${st.join(';')}">${kids(true, 'bin')}</div>`;
        }
        st.push('position:relative', 'box-sizing:border-box');
        return `<div class="${esc(classes.join(' '))}" style="${st.join(';')}">${kids(true, 'fixed')}</div>`;
    }
    }
}

export function renderHtml(root, {theme = 'dark', stylesheet, iconDir, width = 780, height = 560, title = ''} = {}) {
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
html,body{margin:0;background:#3d3846;font-family:Cantarell,'Adwaita Sans','Noto Sans',sans-serif;font-size:14.5px}
.frame{display:inline-block;margin:16px;padding:10px;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.frame *{box-sizing:border-box}
.lbl{display:inline-block;min-width:0}
.nowrap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;min-width:0}
.wrap{white-space:normal}
.btn{display:flex;align-items:center;justify-content:center;cursor:default;min-width:0}
.btn > .nowrap{display:block}
.entry{display:flex;align-items:center;min-width:0;overflow:hidden}
.entry .hint-text{opacity:.5}
.icon{display:inline-block;flex:0 0 auto;width:var(--icon-size,16px);height:var(--icon-size,16px);background-color:currentColor}
.icon.glyph{background:none;font-size:calc(var(--icon-size,16px) * .8);line-height:var(--icon-size,16px);text-align:center}
.qb-check-icon{background-color:currentColor}
${css(stylesheet)}
</style></head><body><div class="frame qb-${theme}"><div style="width:${width}px;height:${height}px;display:flex;flex-direction:column">
${node(root, {iconDir}, false)}
</div></div></body></html>`;
    return page;
}

export function writeHtml(file, root, opts) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, renderHtml(root, opts));
}
