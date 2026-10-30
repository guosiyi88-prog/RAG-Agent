/**
 * 德语**离线兜底**文案（`12-i18n.md` §2 的最后一格之前）。
 *
 * 真表是 `src/static/i18n.json` 的 `de` 列（127 条，经 `/api/i18n/de` 下发，带 en → key 的合并）；
 * 本文件只在接口不可用时顶一下（断网 / 老服务端 / 首屏还没拉到）。因此它**不必**与真表逐条同步：
 * 缺的 key 会显示 key 原文，那是"离线"该有的样子，也正好提醒人"现在没连上"。
 * 德语是最先做全量抽检的市场（12 §6 步骤 5），所以离线兜底用德语而不是中文。
 *
 * key 名严格照 `12-i18n.md` §4；不要在这里加第二语种（五语完整表在 i18n.json）。
 * 取值措辞与真表保持一致：同一个 key 在两条路径上不该是两句话。
 */
export const DICT_DE = {
  // 通用 / 导航 / 无障碍 / Toast
  "common.close": "Schließen", "common.copy": "Kopieren", "common.copied": "Kopiert",
  "nav.chat": "Chat", "nav.fault": "Fehlercode", "nav.ticket": "Ticket", "nav.me": "Profil",
  "a11y.lang": "Sprache wechseln", "a11y.send": "Nachricht senden", "a11y.back": "Zurück",
  "a11y.close": "Schließen", "a11y.tab": "Fußnavigation",
  "toast.offline": "Netzwerk getrennt", "toast.online": "Netzwerk wieder da",
  // 语言名（我的页单选）：真表里 de 用本地化名称（Chinesisch…），德文界面里不该蹦汉字，这里跟真表一致
  "lang.zh": "Chinesisch", "lang.en": "Englisch", "lang.de": "Deutsch", "lang.nl": "Niederländisch", "lang.es": "Spanisch",
  // 对话
  "chat.title": "WOTAI Support", "chat.placeholder": "Frage eingeben…", "chat.send": "Senden",
  "chat.status.searching": "Unterlagen werden durchsucht…", "chat.inserted": "(In die laufende Antwort eingefügt)",
  "chat.err.offline": "Keine Netzwerkverbindung", "chat.err.rate": "Zu viele Anfragen",
  "chat.err.timeout": "Zeitüberschreitung", "chat.err.busy": "Viele Anfragen – du bist in der Warteschlange",
  "chat.err.internal": "System überlastet, bitte später erneut", "chat.err.auth": "Sitzung abgelaufen",
  "chat.retry.send": "Erneut senden", "chat.to.human": "An Mitarbeiter",
  "chat.ticket.created": "Ticket {no} wurde erstellt", "chat.ticket.view": "Ticketstatus ansehen",
  // 引用抽屉
  "cite.aria": "Quelle {i}, Original öffnen", "cite.title": "Quelle {i} / {n}",
  "cite.prev": "Zurück", "cite.next": "Weiter", "cite.page": "S. {page}", "cite.empty": "Kein Quellentext",
  // 故障码页
  "fault.title": "Fehlercode", "fault.placeholder": "Fehlercode eingeben, z. B. E03",
  "fault.recent": "Zuletzt gesucht", "fault.searching": "Wird gesucht …",
  "fault.notfound": "Fehlercode {code} nicht gefunden", "fault.notfound.ask": "KI fragen",
  "fault.invalid": "Format ungültig: Buchstabe plus 2–3 Ziffern",
  "fault.severity.info": "Hinweis", "fault.severity.warn": "Warnung", "fault.severity.fatal": "Kritisch",
  "fault.meaning": "Bedeutung", "fault.actions": "Vorgehen", "fault.source": "Quelle: Fehlercodetabelle",
  "fault.askAI": "Weitere Fragen? KI fragen", "fault.products.balcony": "Balkonspeicher",
  // 工单页
  "ticket.title": "Ticket", "ticket.email.label": "E-Mail", "ticket.email.ph": "du@beispiel.de",
  "ticket.email.invalid": "E-Mail-Format ungültig", "ticket.question.label": "Beschreibung",
  "ticket.question.ph": "Beschreibe kurz dein Problem", "ticket.submit": "Absenden",
  "ticket.submitting": "Wird gesendet …", "ticket.created.title": "Ticket erstellt",
  "ticket.created.no": "Ticketnummer", "ticket.created.hint": "Wir melden uns innerhalb von 4 Stunden",
  "ticket.viewStatus": "Status ansehen", "ticket.status.open": "Offen", "ticket.status.claimed": "In Bearbeitung",
  "ticket.status.escalated": "Eskaliert", "ticket.status.closed": "Geschlossen",
  "ticket.due": "Voraussichtliche Antwort", "ticket.quota": "Tageslimit erreicht – bitte per E-Mail melden",
  // 我的页
  "me.title": "Profil", "me.lang": "Sprache", "me.theme": "Darstellung",
  "me.theme.system": "System", "me.theme.light": "Hell", "me.theme.dark": "Dunkel",
  "me.data": "Daten", "me.data.clear": "Lokale Sitzung löschen",
  "me.data.clear.confirm": "Wirklich löschen? Es beginnt ein neues Gespräch",
  "me.about": "Über", "me.version": "Version {v}", "me.privacy": "Datenschutz", "me.terms": "Nutzungsbedingungen",
};
