'use strict';

const metrics = ['MPJPE ↓', 'PVE ↓', 'F1 ↑', 'MAE (N) ↓', 'F1 ↑', 'MAE (N) ↓'];
const splitLabels = {
  'cross-trial': ['Held-out trials within the same donning', '同一佩戴中留出试次'],
  'cross-session': ['Held-out donning of the same hand', '同一只手留出另一次佩戴'],
  'cross-subject': ['Held-out participants', '留出受试者'],
};
function makeTable(rows) {
  const table = document.createElement('table');
  table.className = 'metrics-table';
  const head = table.createTHead();
  const groups = head.insertRow();
  const columns = head.insertRow();
  const heading = (row, label, scope) => {
    const cell = document.createElement('th');
    cell.scope = scope;
    cell.textContent = label;
    return row.appendChild(cell);
  };
  heading(groups, localized('Method', '方法'), 'col').rowSpan = 2;
  heading(groups, localized('Input', '输入'), 'col').rowSpan = 2;
  for (const group of [['Kinematics (mm)', '姿态（mm）'], ['Region', '手部区域'], ['Vertex', '网格顶点']]) {
    heading(groups, localized(...group), 'colgroup').colSpan = 2;
  }
  for (const metric of metrics) heading(columns, metric, 'col');
  const body = table.createTBody();
  for (const [method, ...values] of rows) {
    const row = body.insertRow();
    row.classList.toggle('method-highlight', method === 'MyoBridge');
    heading(row, method, 'row');
    for (const value of values) row.insertCell().textContent = value;
  }
  return table;
}

async function loadBenchmark() {
  const target = document.getElementById('benchmark-table');
  const status = document.getElementById('benchmark-status');
  const options = [...document.querySelectorAll('[data-split]')];
  try {
    const response = await fetch('benchmark.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const {results} = await response.json();
    let selected = options[0];
    const select = (button, scrollLeft = 0) => {
      selected = button;
      const split = button.dataset.split;
      const rows = results[split];
      target.replaceChildren(makeTable(rows));
      target.scrollLeft = scrollLeft;
      status.textContent = `${localized(...splitLabels[split])} · ${localized(`${rows.length} methods`, `${rows.length} 种方法`)}`;
      for (const option of options) option.setAttribute('aria-pressed', String(option === button));
    };
    for (const option of options) option.addEventListener('click', () => select(option));
    select(options[0]);
    document.addEventListener('site-languagechange', () => select(selected, target.scrollLeft));
  } catch (error) {
    const showError = () => { status.textContent = localized('Benchmark results could not load. Refresh to retry.', '实验表加载失败，请刷新重试。'); };
    showError();
    document.addEventListener('site-languagechange', showError);
    console.error('Benchmark loading failed', error);
  }
}

loadBenchmark();
