'use strict';

/* ==========================================================================
   Соответствие тегов <ChildObjects> человекочитаемым группам дерева.
   Порядок ключей задаёт порядок вывода групп на экране.
   ========================================================================== */
const TAG_MAP = {
  CommonForm: 'Общие формы',
  ExchangePlan: 'Планы обмена',
  Catalog: 'Справочники',
  Document: 'Документы',
  DocumentJournal: 'Журналы документов',
  Report: 'Отчеты',
  DataProcessor: 'Обработки',
  InformationRegister: 'Регистры сведений',
  AccumulationRegister: 'Регистры накопления',
  ChartOfCharacteristicTypes: 'Планы видов характеристик',
};

/* Относительные пути (внутри выбранной папки репозитория), которые ищем. */
const CONFIGURATION_SUFFIX = ['src', 'cf', 'configuration.xml'];
const SMOKE_FOLDER = ['features', 'smoke'];
const BDD_FOLDER = ['features', 'bdd'];

/* ==========================================================================
   Ссылки на элементы интерфейса
   ========================================================================== */
const pickFolderBtn = document.getElementById('pickFolderBtn');
const pathText = document.getElementById('pathText');
const folderInput = document.getElementById('folderInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const includeSmokeCheckbox = document.getElementById('includeSmoke');
const hideUncoveredCheckbox = document.getElementById('hideUncovered');
const statusEl = document.getElementById('status');
const treeContainer = document.getElementById('treeContainer');
const statsContainer = document.getElementById('statsContainer');

/** Список файлов выбранной папки репозитория (File[]) */
let repoFiles = null;

/* ==========================================================================
   Выбор папки репозитория
   ========================================================================== */
pickFolderBtn.addEventListener('click', () => folderInput.click());

folderInput.addEventListener('change', () => {
  const files = Array.from(folderInput.files || []);
  if (!files.length) return;

  repoFiles = files;

  const rootName = files[0].webkitRelativePath.split('/')[0];
  pathText.textContent = rootName;
  pickFolderBtn.classList.add('has-value');

  analyzeBtn.disabled = false;
  clearResults();
  setStatus('');
});

/* ==========================================================================
   «Скрывать непокрытые» — переключается мгновенно, без повторного анализа.
   Группировки (Справочники, Документы и т.д.) остаются на экране всегда,
   даже если после скрытия в них не осталось ни одной строки.
   ========================================================================== */
hideUncoveredCheckbox.addEventListener('change', updateHideUncovered);

function updateHideUncovered() {
  treeContainer.classList.toggle('hide-uncovered', hideUncoveredCheckbox.checked);
}

/* ==========================================================================
   Запуск анализа
   ========================================================================== */
analyzeBtn.addEventListener('click', () => {
  runAnalysis().catch((err) => {
    console.error(err);
    setStatus('Ошибка: ' + err.message, true);
  });
});

async function runAnalysis() {
  if (!repoFiles) return;

  clearResults();
  analyzeBtn.disabled = true;
  const statusLines = [];

  try {
    /* ---- 1. Поиск нужных файлов внутри выбранной папки ---- */
    const configFile = repoFiles.find((f) => matchesSuffix(f.webkitRelativePath, CONFIGURATION_SUFFIX));
    const smokeFiles = repoFiles.filter((f) => isFeatureUnder(f, SMOKE_FOLDER));
    const bddFiles = repoFiles.filter((f) => isFeatureUnder(f, BDD_FOLDER));

    if (!configFile) {
      setStatus(
        'Файл Configuration.xml не найден по пути «...\\src\\cf\\Configuration.xml». ' +
        'Проверьте, что выбран корень репозитория.',
        true
      );
      return;
    }

    const hasDiscoveryIssue = smokeFiles.length === 0 || bddFiles.length === 0;

    statusLines.push(`Configuration.xml: найден (${configFile.webkitRelativePath})`);
    statusLines.push(`Дымовые тесты (features\\smoke): найдено ${smokeFiles.length} файл(ов)`);
    statusLines.push(`Сценарные тесты (features\\bdd): найдено ${bddFiles.length} файл(ов)`);

    /* ---- 2. Список тестов, которые будем учитывать ---- */
    const includeSmoke = includeSmokeCheckbox.checked;
    const testFiles = includeSmoke ? bddFiles.concat(smokeFiles) : bddFiles;

    /* ---- 3. Разбор Configuration.xml -> плоский список объектов ---- */
    const configText = stripBom(await configFile.text());
    const elements = parseConfigurationObjects(configText);

    if (!elements.length) {
      setStatus(statusLines.join('\n') + '\n\nВ Configuration.xml не найдено объектов поддерживаемых типов.', true);
      return;
    }

    /* ---- 4. Сопоставление объектов с содержимым .feature файлов ---- */
    const corpus = (await Promise.all(testFiles.map((f) => f.text()))).join('\n');
    const tokens = tokenize(corpus);
    for (const el of elements) {
      el.covered = tokens.has(el.name);
    }

    /* ---- 5. Вывод дерева и статистики ---- */
    renderTree(elements);
    updateHideUncovered();
    renderStats(elements, includeSmoke);

    setStatus(hasDiscoveryIssue ? statusLines.join('\n') : '');
  } finally {
    analyzeBtn.disabled = false;
  }
}

/* ==========================================================================
   Поиск файлов по относительному пути
   ========================================================================== */

function normalizePath(path) {
  return path.replace(/\\/g, '/');
}

/** true, если путь заканчивается заданной цепочкой сегментов (без учёта регистра) */
function matchesSuffix(path, suffixParts) {
  const normalized = normalizePath(path).toLowerCase();
  const suffix = suffixParts.join('/').toLowerCase();
  return normalized === suffix || normalized.endsWith('/' + suffix);
}

/** true, если файл — это .feature файл где-то внутри заданной папки */
function isFeatureUnder(file, folderParts) {
  const normalized = normalizePath(file.webkitRelativePath).toLowerCase();
  const folderMarker = '/' + folderParts.join('/').toLowerCase() + '/';
  return normalized.includes(folderMarker) && normalized.endsWith('.feature');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/* ==========================================================================
   Разбор Configuration.xml
   ========================================================================== */

function parseConfigurationObjects(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

  if (xmlDoc.getElementsByTagName('parsererror').length) {
    throw new Error('не удалось разобрать Configuration.xml (файл повреждён или имеет неожиданный формат)');
  }

  const allowedTags = new Set(Object.keys(TAG_MAP));
  const childObjectsNodes = xmlDoc.getElementsByTagName('ChildObjects');

  const seen = new Set();
  const elements = [];

  for (const node of childObjectsNodes) {
    for (const child of node.children) {
      if (!allowedTags.has(child.tagName)) continue;
      const name = (child.textContent || '').trim();
      if (!name) continue;

      const key = child.tagName + '::' + name;
      if (seen.has(key)) continue;
      seen.add(key);

      elements.push({ tag: child.tagName, name, covered: false });
    }
  }

  return elements;
}

/* ==========================================================================
   Сопоставление с автотестами: разбиваем текст .feature файлов на "слова"
   (последовательности букв/цифр/подчёркиваний, с поддержкой кириллицы) и
   проверяем, встречается ли имя объекта как отдельное слово.
   Это покрывает оба формата, встречающихся в шагах сценариев:
     ...«ЖурналДокументов.ВедомостиНаВыплатуЗарплаты»   (Тип.Имя)
     ...форма обработки «БлокировкаРаботыПользователей» (просто имя в кавычках)
   ========================================================================== */

function tokenize(text) {
  const matches = text.match(/[\p{L}\p{N}_]+/gu) || [];
  return new Set(matches);
}

/* ==========================================================================
   Рендер дерева
   ========================================================================== */

function renderTree(elements) {
  const byTag = new Map();
  for (const el of elements) {
    if (!byTag.has(el.tag)) byTag.set(el.tag, []);
    byTag.get(el.tag).push(el);
  }

  treeContainer.innerHTML = '';

  for (const tag of Object.keys(TAG_MAP)) {
    const groupElements = byTag.get(tag);
    if (!groupElements || !groupElements.length) continue;

    groupElements.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    const group = document.createElement('div');
    group.className = 'tree-group collapsed';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-group__toggle';
    toggle.setAttribute('aria-expanded', 'false');

    const icon = document.createElement('span');
    icon.className = 'tree-group__icon';
    icon.textContent = '+';
    icon.setAttribute('aria-hidden', 'true');

    const titleText = document.createElement('span');
    titleText.className = 'tree-group__title-text';
    const coveredCount = groupElements.filter((el) => el.covered).length;
    const groupPercent = (coveredCount / groupElements.length * 100).toFixed(2);
    titleText.textContent = `${TAG_MAP[tag]} (${coveredCount}/${groupElements.length}, ${groupPercent}%)`;

    toggle.appendChild(icon);
    toggle.appendChild(titleText);
    toggle.addEventListener('click', () => {
      const collapsed = group.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      icon.textContent = collapsed ? '+' : '-';
    });
    group.appendChild(toggle);

    const list = document.createElement('ul');
    list.className = 'tree-list';

    for (const el of groupElements) {
      const li = document.createElement('li');
      li.className = el.covered ? 'covered' : '';

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = el.covered ? '✔' : '—';

      li.appendChild(mark);
      li.appendChild(document.createTextNode(el.name));
      list.appendChild(li);
    }

    group.appendChild(list);
    treeContainer.appendChild(group);
  }
}

/* ==========================================================================
   Рендер статистики покрытия
   ========================================================================== */

function renderStats(elements, includeSmoke) {
  const total = elements.length;
  const covered = elements.filter((el) => el.covered).length;
  const percent = total ? Math.round((covered / total) * 1000) / 10 : 0;

  statsContainer.innerHTML = '';

  const line = document.createElement('div');
  line.innerHTML =
    `Покрытие автотестами: <span class="stats__figure">${covered} из ${total}</span> объектов, ` +
    `процент покрытия: <span class="stats__figure">${percent}%</span>.`;
  statsContainer.appendChild(line);

  if (includeSmoke) {
    const note = document.createElement('span');
    note.className = 'stats__note';
    note.textContent = 'Дымовые тесты учтены.';
    statsContainer.appendChild(note);
  }
}

/* ==========================================================================
   Вспомогательное
   ========================================================================== */

function clearResults() {
  treeContainer.innerHTML = '';
  statsContainer.innerHTML = '';
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle('status--error', Boolean(isError));
}
