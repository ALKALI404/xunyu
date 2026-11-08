// panel-renderers.js —— AV-005（B8 最小切口）：面板类型 = 一张表
//
// 约定（照 refs\luanyujia\01-场景模式\面板类型与注册.md）：
//   渲染器 = function (body, meta, head) → 可选返回 cleanup 函数（切面板时调用，收定时器/解监听）
//   body 已是 div.panel-body，带 data-kind=<type>；meta 是该面板的 json（原样 + scene）；
//   head 是面板标题栏（聚焦模式下宿主不显示它，平铺模式才显示）。
//
// 加一个类型 = 在下面的 renderers 表里加一项 + 在 scenes/*.json 里写 type，别的地方不用动。
// 加一个面板 = **只改 scenes/*.json**（本单验收第 3 条就是证明这件事）。
(function () {
  var R = {};
  window.PANEL_RENDERERS = R;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function into(body, node) { if (node && node.parentElement !== body) body.appendChild(node); }

  // ── chat：把原来的 .shell 整块搬进面板。DOM 与 CSS 都不改 ⇒ 像素不变 ──
  R.chat = function (body, meta) {
    into(body, document.getElementById('shell'));
  };

  // ── desk：ST-133「入海口」—— 工作台 ⇄ 学习区（段控 + 双 iframe，都活着，只切 display）──
  R.desk = function (body, meta) {
    var wrap = document.getElementById('estuary');
    if (!wrap) return;
    into(body, wrap);
    if (typeof window.estuaryEnter === 'function') window.estuaryEnter();
  };

  // ── space：工具区（搬原块 + 回到分类页，和原来切过去的行为一致）──
  R.space = function (body, meta) {
    var v = document.getElementById('spaceView');
    if (!v) return;
    into(body, v);
    if (!v.getAttribute('data-opened') && typeof window.spaceOpenCats === 'function') {
      v.setAttribute('data-opened', '1');
      window.spaceOpenCats();
    }
  };

  // ── wecom：企微聊天组件（WC-008）—— 独立页面 wecom.html 装进 iframe，数据只走 apiBase HTTP ──
  R.wecom = function (body, meta) {
    var f = document.getElementById('wecomFrame');
    if (!f) return;
    into(body, f);
    // 允许宿主临时带查询串（如 ?mock=1 做验收）；生产环境 XY.wecomQuery 不存在 ⇒ 无参数
    var q = (window.XY && window.XY.wecomQuery) || '';
    var src = 'wecom.html' + q;
    if (f.getAttribute('data-src') !== src) { f.setAttribute('data-src', src); f.src = src; }
  };

  // ── hello：外挂示例，只显示标题 + 一行文字 ──
  R.hello = function (body, meta) {
    var wrap = el('div', 'helloBody');
    wrap.appendChild(el('div', 'helloTitle', meta.title || 'hello'));
    wrap.appendChild(el('div', 'helloLine', meta.text || 'hello 面板：只靠 scenes/*.json 就能加进来。'));
    body.appendChild(wrap);
  };

  // ── 场景引擎 ───────────────────────────────────────────────────────────
  function unknownNote(body, text) {
    body.appendChild(el('div', 'panel-unknown', text));
  }

  var PANELS = {
    active: null,
    scene: null,
    list: [],
    renderers: R,
    unknown: unknownNote,
    build: build,
    setActive: setActive,
    isActive: function (id) { return PANELS.active === id; },
    types: function () { return Object.keys(R); }
  };
  window.PANELS = PANELS;

  function build(scene) {
    var host = document.getElementById('panelHost');
    var nav = document.getElementById('tabs');
    if (!host) return;
    var cols = Math.max(1, Number(scene.cols || 12));
    var tiled = scene.layout === 'tile';
    PANELS.scene = scene;
    PANELS.list = [];
    PANELS.active = null;
    host.innerHTML = '';
    host.classList.toggle('tile', tiled);
    host.style.setProperty('--cols', String(cols));
    if (nav) { nav.innerHTML = ''; nav.style.display = tiled ? 'none' : ''; }

    var panels = Array.isArray(scene.panels) ? scene.panels : [];
    var shown = 0;
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i] || {};
      var type = String(p.type || '');
      var id = String(p.id || type || ('panel-' + i));
      var panel = el('div', 'panel');
      panel.setAttribute('data-panel', id);
      panel.setAttribute('data-type', type);
      var w = Math.max(1, Number(p.w || cols));
      var h = Math.max(1, Number(p.h || 1));
      // 场景里的落位存起来：聚焦时改成铺满整个宿主，平铺时还给它
      panel.setAttribute('data-gc', (Number(p.col || 0) + 1) + ' / span ' + Math.min(w, cols));
      panel.setAttribute('data-gr', (Number(p.row || 0) + 1) + ' / span ' + h);
      panel.style.gridColumn = panel.getAttribute('data-gc');
      panel.style.gridRow = panel.getAttribute('data-gr');
      if (tiled && shown >= 3) panel.style.display = 'none';   // 同屏上限 3，其余收进 tab（追加要求 3）
      shown++;

      var head = el('div', 'panel-head');
      head.appendChild(el('span', 'panel-title', String(p.title || type || id)));
      head.appendChild(el('span', 'panel-type', type));
      var body = el('div', 'panel-body');
      body.setAttribute('data-kind', type);
      panel.appendChild(head);
      panel.appendChild(body);
      host.appendChild(panel);
      PANELS.list.push(panel);

      var meta = { scene: { id: scene.id, name: scene.name } };
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) meta[k] = p[k];
      var fn = R[type];
      if (typeof fn === 'function') {
        try {
          var cleanup = fn(body, meta, head);
          if (typeof cleanup === 'function') panel.__cleanup = cleanup;
        } catch (e) {
          unknownNote(body, '面板「' + type + '」渲染出错：' + (e && e.message ? e.message : e));
        }
      } else {
        unknownNote(body, '未知面板类型: ' + type);   // 不报错、不白屏
      }

      if (nav) {
        var tab = el('button', 'tab', String(p.title || type || id));
        tab.setAttribute('data-panel', id);
        (function (pid) { tab.addEventListener('click', function () { PANELS.setActive(pid); }); })(id);
        nav.appendChild(tab);
      }
    }
    if (tiled && panels.length > 3) {
      try { console.warn('[面板] 同屏上限 3，本次有 ' + panels.length + ' 个面板，超出的收进单独 tab'); } catch (e) { }
    }
    setActive(id0(panels));
  }

  function id0(panels) {
    var p = panels[0] || {};
    return String(p.id || p.type || '');
  }

  function setActive(id) {
    if (!PANELS.list.length) return;
    var tiled = PANELS.scene && PANELS.scene.layout === 'tile';
    var hit = PANELS.list.filter(function (p) { return p.getAttribute('data-panel') === id; })[0] || PANELS.list[0];
    PANELS.active = hit.getAttribute('data-panel');
    PANELS.list.forEach(function (p) {
      var on = tiled ? true : (p === hit);
      p.classList.toggle('focus', on);
      // 聚焦模式：当前面板铺满宿主（不管 json 里写的是几列几行）；平铺模式：用回 json 的落位
      p.style.gridColumn = tiled ? p.getAttribute('data-gc') : '1 / -1';
      p.style.gridRow = tiled ? p.getAttribute('data-gr') : '1 / -1';
    });
    var nav = document.getElementById('tabs');
    if (nav) {
      var tabs = nav.querySelectorAll('.tab');
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-panel') === PANELS.active);
    }
  }
})();
