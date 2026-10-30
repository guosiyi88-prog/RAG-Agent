/**
 * 五语**界面骨架**文案的离线兜底（`12-i18n.md` §2 的第二格）。
 *
 * 真表是 `src/static/i18n.json`（127 条 × 5 语），由 `/api/i18n/:lang` 合并后下发；`08#01` 之后
 * 页面正常路径只读那份合并结果，本表只在**接口不可用**时顶一下（断网、老服务端、首屏还没拉到）。
 * 因此这里刻意只覆盖一眼能看见的骨架：导航、标题、占位符、发送/关闭/复制、我的页三项。
 * 深水区（错误文案、故障码步骤、工单状态）留给 `i18n-de.js` 的德语与 key 原文 —— 离线时
 * 显示几个 key 原文比维护第二份 127 条真表要好：两份真表一定会漂，漂了还没人发现。
 *
 * key 名照 `12-i18n.md` §4；取值的措辞与真表保持一致（同一个 key 在两条路径上不该是两句话）。
 */
const CHROME = {
  zh: {
    "nav.chat": "对话", "nav.fault": "故障码", "nav.ticket": "工单", "nav.me": "我的",
    "chat.title": "沃泰支持", "chat.placeholder": "输入问题…",
    "fault.title": "故障码", "fault.placeholder": "输入故障码，如 E03",
    "ticket.title": "工单", "ticket.email.label": "联系邮箱", "ticket.submit": "提交",
    "me.title": "我的", "me.lang": "语言", "me.theme": "外观",
    "common.close": "关闭", "common.copy": "复制", "common.copied": "已复制",
    "a11y.lang": "切换语言", "a11y.send": "发送消息", "a11y.tab": "底部导航",
  },
  en: {
    "nav.chat": "Chat", "nav.fault": "Fault code", "nav.ticket": "Ticket", "nav.me": "Profile",
    "chat.title": "WOTAI Support", "chat.placeholder": "Type your question…",
    "fault.title": "Fault code", "fault.placeholder": "Enter a code, e.g. E03",
    "ticket.title": "Ticket", "ticket.email.label": "Contact email", "ticket.submit": "Submit",
    "me.title": "Profile", "me.lang": "Language", "me.theme": "Appearance",
    "common.close": "Close", "common.copy": "Copy", "common.copied": "Copied",
    "a11y.lang": "Change language", "a11y.send": "Send message", "a11y.tab": "Bottom navigation",
  },
  de: {
    "nav.chat": "Chat", "nav.fault": "Fehlercode", "nav.ticket": "Ticket", "nav.me": "Profil",
    "chat.title": "WOTAI Support", "chat.placeholder": "Frage eingeben…",
    "fault.title": "Fehlercode", "fault.placeholder": "Fehlercode eingeben, z. B. E03",
    "ticket.title": "Ticket", "ticket.email.label": "Kontakt-E-Mail", "ticket.submit": "Absenden",
    "me.title": "Profil", "me.lang": "Sprache", "me.theme": "Darstellung",
    "common.close": "Schließen", "common.copy": "Kopieren", "common.copied": "Kopiert",
    "a11y.lang": "Sprache wechseln", "a11y.send": "Nachricht senden", "a11y.tab": "Fußnavigation",
  },
  nl: {
    "nav.chat": "Chat", "nav.fault": "Foutcode", "nav.ticket": "Ticket", "nav.me": "Profiel",
    "chat.title": "WOTAI Support", "chat.placeholder": "Stel je vraag…",
    "fault.title": "Foutcode", "fault.placeholder": "Voer een code in, bijv. E03",
    "ticket.title": "Ticket", "ticket.email.label": "Contact e-mail", "ticket.submit": "Versturen",
    "me.title": "Profiel", "me.lang": "Taal", "me.theme": "Weergave",
    "common.close": "Sluiten", "common.copy": "Kopiëren", "common.copied": "Gekopieerd",
    "a11y.lang": "Taal wijzigen", "a11y.send": "Bericht versturen", "a11y.tab": "Navigatie onderaan",
  },
  es: {
    "nav.chat": "Chat", "nav.fault": "Código de fallo", "nav.ticket": "Ticket", "nav.me": "Perfil",
    "chat.title": "WOTAI Support", "chat.placeholder": "Escribe tu pregunta…",
    "fault.title": "Código de fallo", "fault.placeholder": "Introduce un código, p. ej. E03",
    "ticket.title": "Ticket", "ticket.email.label": "Correo de contacto", "ticket.submit": "Enviar",
    "me.title": "Perfil", "me.lang": "Idioma", "me.theme": "Apariencia",
    "common.close": "Cerrar", "common.copy": "Copiar", "common.copied": "Copiado",
    "a11y.lang": "Cambiar idioma", "a11y.send": "Enviar mensaje", "a11y.tab": "Navegación inferior",
  },
};

/** 取某语种的骨架表；未知语言返回空对象（调用方继续回落到德语兜底表）。 */
export function chromeDict(lang) {
  return CHROME[lang] ?? {};
}
