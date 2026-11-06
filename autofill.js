// ==UserScript==
// @name         Workday Autofill
// @version      1.0.0
// @description  Fills the Workday job applications ( Right now experience only: work experience, education, languages, skills, websites) from your saved profile.
// @match        https://*.myworkdayjobs.com/*
// @match        https://*.myworkday.com/*
// @match        https://*.myworkdaysite.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==
 
(function () {
  'use strict';
/*
  YOUR PROFILE. Edit here, or use the "Edit data" button on the panel
  (that copy is saved in Tampermonkey and wins over this one).
  Dates: month 1-12, year 4 digits. Set "skip": true to leave an entry out.
*/
  const DEFAULT_PROFILE = {
    work: [
      {
        title: 'Software Engineering Intern',
        company: 'Example Corp',
        location: 'Springfield, IL',
        current: false,
        from: { month: 6, year: 2025 },
        to: { month: 8, year: 2025 },
        description: 'Job description.',
      },
    ],
    education: [
      {
        school: 'Example University',
        degree: ['BS', 'B.S.', 'Bachelor of Science', "Bachelor's Degree"],
        fieldOfStudy: ['Computer Science'],
        gpa: '',
        fromYear: 2022,
        toYear: 2026,
      },
    ],
    languages: [
      { language: ['English'], fluent: true, level: ['5 - Fluent', 'Fluent'] },
    ],
    skills: ['Python', 'SQL', 'Git'],
    websites: ['https://example.com'],
    linkedin: '',
  };
 
  //  Storage
  const STORE_KEY = 'wdAutofillProfile';
  const hasGM = typeof GM_getValue === 'function';
  const store = {
    get(k) {
      try { return hasGM ? GM_getValue(k, null) : localStorage.getItem(k); } catch (e) { return null; }
    },
    set(k, v) {
      try { hasGM ? GM_setValue(k, v) : (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)); } catch (e) { /* ignore */ }
    },
  };
  function loadProfile() {
    const raw = store.get(STORE_KEY);
    if (raw) { try { return JSON.parse(raw); } catch (e) { /* fall through */ } }
    return DEFAULT_PROFILE;
  }
 
  //  Small DOM helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim().toLowerCase();
  const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const pad2 = (n) => String(n).padStart(2, '0');
 
  async function waitFor(fn, timeout = 4000, step = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return fn();
  }
 
  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
 
  // Types text the way a person would, so Workday's React state sees it.
  async function setText(el, value) {
    if (!el) return false;
    value = value == null ? '' : String(value);
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.click();
    await sleep(30);
    if (el.value !== value) {
      el.select && el.select();
      let ok = false;
      try {
        ok = value === '' ? document.execCommand('delete', false) : document.execCommand('insertText', false, value);
      } catch (e) { ok = false; }
      if (!ok || el.value !== value) nativeSet(el, value);
    }
    await sleep(30);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await sleep(40);
    return el.value === value;
  }
 
  function pressKey(el, key) {
    const opts = { key, code: key, keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }
 
  async function setCheckbox(el, want) {
    if (!el) return false;
    if (!!el.checked !== !!want) {
      el.scrollIntoView({ block: 'center' });
      el.click();
      await sleep(150);
    }
    return !!el.checked === !!want;
  }
 
  // Label text -> control inside the same form field.
  function labelText(el) {
    return norm(el.textContent);
  }
  function fieldByLabel(root, re, selector) {
    const labels = root.querySelectorAll('label, legend, [data-automation-id="formLabel"], [id$="-label"]');
    for (const lab of labels) {
      if (!re.test(labelText(lab))) continue;
      const forId = lab.getAttribute('for');
      if (forId) {
        const t = document.getElementById(forId);
        if (t && root.contains(t) && t.matches(selector)) return t;
      }
      let box = lab.parentElement;
      for (let i = 0; i < 4 && box && box !== root; i++, box = box.parentElement) {
        const t = box.querySelector(selector);
        if (t) return t;
      }
    }
    return null;
  }
 
  // Find a control by Workday's id suffix, data-automation-id, or its label.
  function findField(root, spec) {
    const { idSuffix = [], auto = [], label, selector = 'input, textarea, button' } = spec;
    for (const s of idSuffix) {
      const el = root.querySelector(`[id$="${s}"]`);
      if (el && el.matches(selector)) return el;
      if (el) { const inner = el.querySelector(selector); if (inner) return inner; }
    }
    for (const a of auto) {
      const el = root.querySelector(`[data-automation-id="${a}"]`);
      if (el && el.matches(selector)) return el;
      if (el) { const inner = el.querySelector(selector); if (inner) return inner; }
    }
    return label ? fieldByLabel(root, label, selector) : null;
  }
 
  // Pick an option from an open Workday dropdown / search list.
  function openOptions() {
    const sel = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"]';
    return [...document.querySelectorAll(sel)].filter(visible);
  }
  function bestOption(options, wanted) {
    const text = (o) => norm(o.getAttribute('data-automation-label') || o.textContent);
    for (const w of asList(wanted)) {
      const n = norm(w);
      const hit = options.find((o) => text(o) === n);
      if (hit) return hit;
    }
    for (const w of asList(wanted)) {
      const n = norm(w);
      const hit = options.find((o) => text(o).startsWith(n + ' (') || text(o).startsWith(n + ' -'));
      if (hit) return hit;
    }
    for (const w of asList(wanted)) {
      const n = norm(w);
      if (n.length < 4) continue;
      const hit = options.find((o) => text(o).includes(n));
      if (hit) return hit;
    }
    return null;
  }
  function clickOption(o) {
    o.scrollIntoView({ block: 'nearest' });
    const target = o.querySelector('[data-automation-id="promptOption"], input[type="radio"], div') || o;
    for (const t of [o, target]) {
      t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
    o.click();
  }
 
  // Dropdown button (Degree, Language, proficiency levels).
  async function selectDropdown(btn, wanted) {
    if (!btn) return false;
    const current = norm(btn.textContent || btn.value);
    if (asList(wanted).some((w) => norm(w) === current)) return true;
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    const opts = await waitFor(() => { const o = openOptions(); return o.length ? o : null; }, 3000);
    if (!opts) return false;
    const hit = bestOption(opts, wanted);
    if (!hit) { pressKey(document.activeElement || btn, 'Escape'); await sleep(150); return false; }
    clickOption(hit);
    await sleep(300);
    return true;
  }
 
  // Search box with selectable results (School, Field of Study, Skills).
  function selectedPills(root) {
    return [...root.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] li, [role="listitem"]')]
      .map((p) => norm(p.getAttribute('title') || p.textContent));
  }
  async function selectPrompt(input, wanted, root) {
    if (!input) return false;
    const box = root || input.closest('[data-automation-id^="formField"]') || input.parentElement.parentElement;
    const pills = selectedPills(box);
    if (asList(wanted).some((w) => pills.some((p) => p === norm(w) || p.startsWith(norm(w) + ' (')))) return true;
    for (const w of asList(wanted)) {
      input.scrollIntoView({ block: 'center' });
      input.focus();
      input.click();
      input.select && input.select();
      try { document.execCommand('insertText', false, w); } catch (e) { /* ignore */ }
      if (input.value !== w) nativeSet(input, w);
      pressKey(input, 'Enter');
      const opts = await waitFor(() => { const o = openOptions(); return o.length ? o : null; }, 3500);
      const hit = opts && bestOption(opts, [w]);
      if (hit) {
        clickOption(hit);
        await sleep(400);
        pressKey(input, 'Escape');
        await sleep(150);
        return true;
      }
      // clear what we typed and try the next spelling
      input.focus();
      input.select && input.select();
      try { document.execCommand('delete', false); } catch (e) { /* ignore */ }
      if (input.value) nativeSet(input, '');
      pressKey(input, 'Escape');
      await sleep(200);
    }
    return false;
  }
 
  // Text field that may be a plain input or a search box (School varies by company).
  async function setTextOrPrompt(input, value) {
    if (!input) return false;
    const isPrompt = input.getAttribute('data-uxi-widget-type') === 'selectinput' ||
      !!input.closest('[data-automation-id="multiSelectContainer"], [data-uxi-widget-type="multiselect"]');
    return isPrompt ? selectPrompt(input, asList(value)) : setText(input, asList(value)[0]);
  }
 
  //  Finding sections and entries
  const SECTIONS = {
    work: { title: /^work experience$/i, idPrefix: 'workExperience-', anchor: { idSuffix: ['--jobTitle'], auto: ['jobTitle'], label: /^job title$/, selector: 'input' } },
    education: { title: /^education$/i, idPrefix: 'education-', anchor: { idSuffix: ['--schoolName', '--school'], auto: ['school', 'schoolName'], label: /^school( or university)?$|^university$/, selector: 'input' } },
    languages: { title: /^languages?$/i, idPrefix: 'language-', anchor: { idSuffix: ['--language'], auto: ['language'], label: /^language$/, selector: 'button, input' } },
    websites: { title: /^websites?$/i, idPrefix: 'webAddress-', anchor: { idSuffix: ['--url'], auto: ['website'], label: /^url$/, selector: 'input' } },
  };
 
  function sectionHeading(name) {
    const re = SECTIONS[name].title;
    return [...document.querySelectorAll('h2, h3, h4, legend, [role="heading"], [data-automation-id$="Heading"], [data-automation-id$="heading"]')]
      .find((h) => visible(h) && re.test(norm(h.textContent)));
  }
 
  function allAnchors(name) {
    const a = SECTIONS[name].anchor;
    const set = new Set();
    for (const s of a.idSuffix) document.querySelectorAll(`[id^="${SECTIONS[name].idPrefix}"][id$="${s}"]`).forEach((e) => set.add(e));
    if (!set.size) for (const s of a.auto) document.querySelectorAll(`[data-automation-id="${s}"]`).forEach((e) => set.add(e.matches(a.selector) ? e : e.querySelector(a.selector)));
    if (!set.size) {
      // label fallback: every field labelled like the anchor
      document.querySelectorAll('label, [data-automation-id="formLabel"]').forEach((lab) => {
        if (!a.label.test(labelText(lab))) return;
        const f = lab.getAttribute('for') && document.getElementById(lab.getAttribute('for'));
        if (f) { set.add(f); return; }
        let box = lab.parentElement;
        for (let i = 0; i < 4 && box; i++, box = box.parentElement) { const t = box.querySelector(a.selector); if (t) { set.add(t); break; } }
      });
    }
    set.delete(null);
    return [...set].filter((e) => e && e.isConnected).sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }
 
  function otherAnchors(name) {
    return Object.keys(SECTIONS).filter((n) => n !== name).flatMap((n) => {
      const a = SECTIONS[n].anchor;
      return [...a.idSuffix.map((s) => `[id$="${s}"]`), ...a.auto.map((s) => `[data-automation-id="${s}"]`)];
    }).join(',');
  }
 
  // The DOM block that holds one entry (e.g. "Work Experience 2").
  function entryRoot(name, anchor) {
    const m = anchor.id && anchor.id.match(new RegExp('^(' + SECTIONS[name].idPrefix + '\\d+--)'));
    if (m) {
      const fields = document.querySelectorAll(`[id^="${m[1]}"]`);
      let el = anchor.parentElement;
      while (el && ![...fields].every((f) => el.contains(f))) el = el.parentElement;
      if (el) return el;
    }
    const group = anchor.closest('[role="group"], fieldset');
    if (group && group.querySelectorAll('input, textarea, button').length > 1) {
      const count = allAnchors(name).filter((a) => group.contains(a)).length;
      if (count === 1) return group;
    }
    const foreign = otherAnchors(name);
    const mine = allAnchors(name);
    let el = anchor.parentElement;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (mine.filter((a) => p.contains(a)).length > 1) break;
      if (foreign && p.querySelector(foreign)) break;
      if ([...p.querySelectorAll('button')].some((b) => /^add( another)?$/i.test(norm(b.textContent)))) break;
      el = p;
    }
    return el;
  }
 
  function addButton(name) {
    const sectionWord = { work: 'work experience', education: 'education', languages: 'language', websites: 'website' }[name];
    const btns = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const byAria = btns.find((b) => /^add/.test(norm(b.getAttribute('aria-label'))) && norm(b.getAttribute('aria-label')).includes(sectionWord));
    if (byAria) return byAria;
    const h = sectionHeading(name);
    if (!h) return null;
    // smallest ancestor of the heading that has an Add button
    let el = h.parentElement;
    while (el && el !== document.body) {
      const adds = [...el.querySelectorAll('button, [role="button"]')].filter((b) => visible(b) && /^add( another)?$/i.test(norm(b.textContent)));
      if (adds.length) {
        const after = adds.filter((b) => h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return (after.length ? after : adds)[0];
      }
      el = el.parentElement;
    }
    return null;
  }
 
  async function ensureEntries(name, n, log) {
    let cur = allAnchors(name).length;
    let guard = 0;
    while (cur < n && guard++ < n + 3) {
      const b = addButton(name);
      if (!b) { log(`Could not find the Add button for ${name}.`, 'warn'); return cur; }
      b.scrollIntoView({ block: 'center' });
      b.click();
      const before = cur;
      await waitFor(() => allAnchors(name).length > before, 4000);
      await sleep(300);
      cur = allAnchors(name).length;
      if (cur === before) { log(`Clicking Add did not create a new ${name} entry.`, 'warn'); return cur; }
    }
    return cur;
  }
 
  async function deleteExtra(name, keep, log) {
    let anchors = allAnchors(name);
    while (anchors.length > keep) {
      const root = entryRoot(name, anchors[anchors.length - 1]);
      const del = [...root.querySelectorAll('button, [role="button"]')].find((b) => /^delete/.test(norm(b.getAttribute('aria-label') || b.textContent)));
      if (!del) { log(`Left ${anchors.length - keep} extra ${name} entr${anchors.length - keep > 1 ? 'ies' : 'y'}; delete by hand.`, 'warn'); return; }
      del.click();
      await sleep(400);
      // some tenants ask to confirm
      const ok = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button, [data-automation-id="popUpDialog"] button')]
        .find((b) => visible(b) && /^(ok|delete|yes|remove)$/i.test(norm(b.textContent)));
      if (ok) { ok.click(); await sleep(300); }
      const after = allAnchors(name);
      if (after.length >= anchors.length) { log(`Could not delete an extra ${name} entry; delete it by hand.`, 'warn'); return; }
      anchors = after;
    }
  }
 
  // Month/year date boxes inside an entry, in page order.
  function dateInputs(root, part) {
    return [...root.querySelectorAll(`input[data-automation-id="dateSection${part}-input"], input[id*="dateSection${part}-input"]`)];
  }
  async function setDate(root, which, d, log, label) {
    if (!d) return;
    const prefix = which === 0 ? ['--startDate', '--firstYearAttended'] : ['--endDate', '--lastYearAttended'];
    let month = null, year = null;
    for (const p of prefix) {
      month = month || root.querySelector(`input[id*="${p}-dateSectionMonth-input"]`);
      year = year || root.querySelector(`input[id*="${p}-dateSectionYear-input"]`);
    }
    if (!year) { month = dateInputs(root, 'Month')[which]; year = dateInputs(root, 'Year')[which]; }
    // Single "MM/YYYY" text box fallback
    if (!year) {
      const lab = which === 0 ? /^from$|start date/ : /^to( \(actual or expected\))?$|end date/;
      const single = fieldByLabel(root, lab, 'input');
      if (single) { await setText(single, d.month ? `${pad2(d.month)}/${d.year}` : String(d.year)); return; }
      log(`${label}: no ${which === 0 ? 'From' : 'To'} date box found.`, 'warn');
      return;
    }
    if (month && d.month) await setText(month, pad2(d.month));
    await setText(year, String(d.year));
  }
 
  //  Fillers
  async function fillWork(p, log, opts) {
    const items = asList(p.work).filter((w) => !w.skip);
    if (!items.length) return;
    const n = await ensureEntries('work', items.length, log);
    if (opts.deleteExtra) await deleteExtra('work', items.length, log);
    const anchors = allAnchors('work');
    for (let i = 0; i < Math.min(items.length, anchors.length, n); i++) {
      const w = items[i];
      const root = entryRoot('work', anchors[i]);
      const L = `Work ${i + 1} (${w.company})`;
      await setText(anchors[i], w.title);
      await setText(findField(root, { idSuffix: ['--companyName', '--company'], auto: ['company'], label: /^company$/, selector: 'input' }), w.company);
      const loc = findField(root, { idSuffix: ['--location'], auto: ['location'], label: /^location$/, selector: 'input' });
      if (loc && w.location) await setText(loc, w.location);
      const cur = findField(root, { idSuffix: ['--currentlyWorkHere'], auto: ['currentlyWorkHere'], label: /currently work here/, selector: 'input[type="checkbox"]' });
      if (cur) await setCheckbox(cur, !!w.current);
      await sleep(150);
      await setDate(root, 0, w.from, log, L);
      if (!w.current) await setDate(root, 1, w.to, log, L);
      const desc = findField(root, { idSuffix: ['--roleDescription', '--description'], auto: ['description'], label: /role description|^description$/, selector: 'textarea, input' });
      if (desc) await setText(desc, w.description); else log(`${L}: no Role Description box found.`, 'warn');
      log(`${L} filled.`);
    }
    if (anchors.length < items.length) log(`Only ${anchors.length} of ${items.length} work entries could be created.`, 'warn');
  }
 
  async function fillEducation(p, log, opts) {
    const items = asList(p.education).filter((e) => !e.skip);
    if (!items.length) return;
    await ensureEntries('education', items.length, log);
    if (opts.deleteExtra) await deleteExtra('education', items.length, log);
    const anchors = allAnchors('education');
    for (let i = 0; i < Math.min(items.length, anchors.length); i++) {
      const e = items[i];
      const root = entryRoot('education', anchors[i]);
      const L = `Education ${i + 1} (${e.school})`;
      if (!(await setTextOrPrompt(anchors[i], e.school))) log(`${L}: pick the school by hand.`, 'warn');
      const deg = findField(root, { idSuffix: ['--degree'], auto: ['degree'], label: /^degree$/, selector: 'button, input' });
      if (deg && !(deg.tagName === 'BUTTON' ? await selectDropdown(deg, e.degree) : await setTextOrPrompt(deg, e.degree))) log(`${L}: pick the Degree by hand (wanted ${asList(e.degree)[0]}).`, 'warn');
      const fos = findField(root, { idSuffix: ['--fieldOfStudy'], auto: ['field-of-study', 'fieldOfStudy'], label: /field of study|^major/, selector: 'input' });
      if (fos && e.fieldOfStudy && !(await selectPrompt(fos, e.fieldOfStudy))) log(`${L}: pick Field of Study by hand.`, 'warn');
      const gpa = findField(root, { idSuffix: ['--gradeAverage', '--gpa'], auto: ['gpa', 'gradeAverage'], label: /overall result|gpa/, selector: 'input' });
      if (gpa && e.gpa) await setText(gpa, e.gpa);
      await setDate(root, 0, e.fromYear && { year: e.fromYear }, log, L);
      await setDate(root, 1, e.toYear && { year: e.toYear }, log, L);
      log(`${L} filled.`);
    }
  }
 
  async function fillLanguages(p, log, opts) {
    const items = asList(p.languages).filter((x) => !x.skip);
    if (!items.length) return;
    if (!sectionHeading('languages') && !allAnchors('languages').length) { log('No Languages section on this page; skipped.'); return; }
    await ensureEntries('languages', items.length, log);
    if (opts.deleteExtra) await deleteExtra('languages', items.length, log);
    const anchors = allAnchors('languages');
    for (let i = 0; i < Math.min(items.length, anchors.length); i++) {
      const x = items[i];
      const root = entryRoot('languages', anchors[i]);
      const L = `Language ${i + 1} (${asList(x.language)[0]})`;
      if (!(await selectDropdown(anchors[i], x.language))) log(`${L}: pick the language by hand.`, 'warn');
      const fl = findField(root, { idSuffix: ['--native'], auto: ['nativeLanguage'], label: /fluent in this language|native/, selector: 'input[type="checkbox"]' });
      if (fl) await setCheckbox(fl, !!x.fluent);
      await sleep(200);
      for (const lvl of ['comprehension', 'overall', 'reading', 'speaking', 'writing']) {
        const b = fieldByLabel(root, new RegExp('^' + lvl + '$'), 'button');
        if (b && !(await selectDropdown(b, x.level))) log(`${L}: set ${lvl} by hand.`, 'warn');
      }
      log(`${L} filled.`);
    }
  }
 
  function skillsInput() {
    const direct = document.querySelector('input[id$="skills--skills"], input[id^="skills"], [data-automation-id="formField-skills"] input, [data-automation-id*="skills" i] input');
    if (direct) return direct;
    // fallback: first text box after the "Skills" heading
    const h = [...document.querySelectorAll('h2, h3, h4, legend, [role="heading"]')].find((x) => visible(x) && /^skills$/i.test(norm(x.textContent)));
    if (!h) return null;
    return [...document.querySelectorAll('input[type="text"], input:not([type])')]
      .find((i) => visible(i) && (h.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)) || null;
  }
 
  async function fillSkills(p, log) {
    const skills = asList(p.skills);
    if (!skills.length) return;
    const input = skillsInput();
    if (!input) { log('No Skills box on this page; skipped.'); return; }
    const box = input.closest('[data-automation-id^="formField"]') || input.parentElement.parentElement.parentElement;
    const missed = [];
    for (const s of skills) {
      const ok = await selectPrompt(input, [s], box);
      if (!ok) missed.push(s);
    }
    log(`Skills: added ${skills.length - missed.length} of ${skills.length}.`);
    if (missed.length) log(`Skills not found in this company's list: ${missed.join(', ')}`, 'warn');
  }
 
  async function fillWebsites(p, log, opts) {
    const urls = asList(p.websites);
    if (urls.length && (sectionHeading('websites') || allAnchors('websites').length)) {
      await ensureEntries('websites', urls.length, log);
      if (opts.deleteExtra) await deleteExtra('websites', urls.length, log);
      const anchors = allAnchors('websites');
      for (let i = 0; i < Math.min(urls.length, anchors.length); i++) await setText(anchors[i], urls[i]);
      log(`Websites: filled ${Math.min(urls.length, anchors.length)}.`);
    }
    if (p.linkedin) {
      const li = document.querySelector('input[id$="linkedInAccount"], input[data-automation-id="linkedinQuestion"]') || fieldByLabel(document, /linkedin/, 'input');
      if (li) { await setText(li, p.linkedin); log('LinkedIn filled.'); }
    }
  }
 
  //  Panel
  function buildPanel() {
    if (document.getElementById('wd-autofill-host')) return;
    const host = document.createElement('div');
    host.id = 'wd-autofill-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial}
        *{box-sizing:border-box;font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
        .fab{background:#0b5cad;color:#fff;border:0;border-radius:20px;padding:9px 14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);font-weight:600}
        .card{width:340px;max-height:80vh;overflow:auto;background:#fff;color:#1d2433;border:1px solid #cfd6e0;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:12px}
        .row{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
        button.b{border:1px solid #0b5cad;background:#fff;color:#0b5cad;border-radius:6px;padding:5px 9px;cursor:pointer}
        button.b.primary{background:#0b5cad;color:#fff}
        button.b:disabled{opacity:.5;cursor:default}
        h1{font-size:14px;font-weight:700;margin:0;flex:1}
        .top{display:flex;align-items:center;gap:8px}
        .x{border:0;background:none;font-size:18px;cursor:pointer;color:#555}
        label.opt{display:flex;gap:6px;align-items:flex-start;margin:4px 0;font-size:12px}
        .log{background:#f5f7fa;border-radius:6px;padding:6px;margin-top:6px;max-height:180px;overflow:auto;font-size:12px;white-space:pre-wrap}
        .warn{color:#a15c00}
        textarea{width:100%;height:300px;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace}
        .hidden{display:none}
      </style>
      <button class="fab" id="fab">Autofill My Experience</button>
      <div class="card hidden" id="card">
        <div class="top"><h1>Workday autofill</h1><button class="x" id="close" title="Hide">×</button></div>
        <div class="row">
          <button class="b primary" data-run="all">Fill all</button>
          <button class="b" data-run="work">Work</button>
          <button class="b" data-run="education">Education</button>
          <button class="b" data-run="languages">Languages</button>
          <button class="b" data-run="skills">Skills</button>
          <button class="b" data-run="websites">Websites</button>
        </div>
        <label class="opt"><input type="checkbox" id="delextra" checked> Delete extra entries Workday made from my resume</label>
        <div class="row"><button class="b" id="edit">Edit data</button></div>
        <div id="editor" class="hidden">
          <textarea id="json" spellcheck="false"></textarea>
          <div class="row"><button class="b primary" id="save">Save</button><button class="b" id="reset">Reset to built-in</button><button class="b" id="cancel">Cancel</button></div>
        </div>
        <div class="log" id="log">Open the My Experience step, then press Fill all. Check every field before you continue.</div>
      </div>`;
    const $ = (id) => root.getElementById(id);
    const logEl = $('log');
    const log = (msg, kind) => {
      const d = document.createElement('div');
      if (kind === 'warn') d.className = 'warn';
      d.textContent = (kind === 'warn' ? '⚠ ' : '✓ ') + msg;
      logEl.appendChild(d);
      logEl.scrollTop = logEl.scrollHeight;
    };
    $('fab').onclick = () => { $('card').classList.remove('hidden'); $('fab').classList.add('hidden'); };
    $('close').onclick = () => { $('card').classList.add('hidden'); $('fab').classList.remove('hidden'); };
    $('edit').onclick = () => { $('json').value = JSON.stringify(loadProfile(), null, 2); $('editor').classList.remove('hidden'); };
    $('cancel').onclick = () => $('editor').classList.add('hidden');
    $('reset').onclick = () => { store.set(STORE_KEY, null); $('json').value = JSON.stringify(DEFAULT_PROFILE, null, 2); log('Reset to the built-in profile.'); };
    $('save').onclick = () => {
      try { const v = JSON.parse($('json').value); store.set(STORE_KEY, JSON.stringify(v)); $('editor').classList.add('hidden'); log('Saved your edits.'); }
      catch (e) { log('That is not valid JSON: ' + e.message, 'warn'); }
    };
    root.querySelectorAll('[data-run]').forEach((btn) => {
      btn.onclick = async () => {
        const which = btn.getAttribute('data-run');
        const all = root.querySelectorAll('[data-run]');
        all.forEach((b) => (b.disabled = true));
        logEl.textContent = '';
        const p = loadProfile();
        const opts = { deleteExtra: $('delextra').checked };
        const steps = which === 'all' ? ['work', 'education', 'languages', 'skills', 'websites'] : [which];
        const fns = { work: fillWork, education: fillEducation, languages: fillLanguages, skills: fillSkills, websites: fillWebsites };
        try {
          for (const s of steps) await fns[s](p, log, opts);
          log('Done. Review the page, then Save and Continue.');
        } catch (e) {
          log('Stopped with an error: ' + (e && e.message), 'warn');
          console.error('[workday-autofill]', e);
        } finally {
          all.forEach((b) => (b.disabled = false));
        }
      };
    });
  }
 
  // Expose for testing / console use.
  window.__wdAutofill = { fillWork, fillEducation, fillLanguages, fillSkills, fillWebsites, loadProfile, DEFAULT_PROFILE };
 
  if (document.body) buildPanel();
  else document.addEventListener('DOMContentLoaded', buildPanel);
  // Workday is a single-page app; make sure the panel survives page swaps.
  setInterval(() => { if (!document.getElementById('wd-autofill-host')) buildPanel(); }, 2000);
})();
 