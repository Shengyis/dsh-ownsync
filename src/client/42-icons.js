/* ---------- 图标 ---------- */
// 同一族的两枚标记：24×24 视图、半径 9、圆头、1.8 线宽、跟随 currentColor。
// 同步：两段圆弧 + 两个箭头（refresh-cw）
// 重启：一段圆弧 + 一个箭头（rotate-cw），箭头位置与形状和同步完全一致
function iconFrame(children) {
  return e(
    'svg',
    {
      className: 'os-icon',
      viewBox: '0 0 24 24',
      width: 15,
      height: 15,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    ...children,
  );
}

// 同步：两个半圈箭头
function IconSync() {
  return iconFrame([
    e('polyline', { key: 'arrow-top', points: '23 4 23 10 17 10' }),
    e('polyline', { key: 'arrow-bottom', points: '1 20 1 14 7 14' }),
    e('path', { key: 'arc-top', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10' }),
    e('path', { key: 'arc-bottom', d: 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
  ]);
}

// 重启：单段圆弧 + 一个箭头，箭头与同步的顶部箭头同形同位置
function IconRestart() {
  return iconFrame([
    e('polyline', { key: 'arrow', points: '23 4 23 10 17 10' }),
    e('path', { key: 'arc', d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
  ]);
}

// 设置：齿轮（同一网格与线宽）
function IconGear() {
  return iconFrame([
    e('circle', { key: 'ring', cx: 12, cy: 12, r: 3 }),
    e('path', {
      key: 'teeth',
      d:
        'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
    }),
  ]);
}
