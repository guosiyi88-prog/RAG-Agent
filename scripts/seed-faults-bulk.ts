/**
 * 批量故障卡模拟数据：造 N 条（默认 1000）五语齐全的 `fault_codes` 行，直写数据库。
 *
 * **为什么要有这个脚本**：管理端的故障卡列表、筛选、`n/5` 缺语标记、发布/归档按钮，
 * 以及公开的 `/api/fault/:code`，在只有 6 条种子数据时看不出任何"多起来是什么样"——
 * 分页只有一页、筛选点不出组合、看板数字永远不变。演示与压测需要量，量不该手敲。
 *
 * **内容不是纯随机串**：14 个故障族（并网电压/频率、电池单体电压/温度、绝缘、功率模块过流、
 * 逆变器过温、BMS 与云端通讯、可燃气体、离网过载）各自有一份五语模板，槽位只填
 * 实测值 / 持续时长 / 机型 / 场景四个事实，所以文案在五种语言里都读得通，
 * 也不会出现"德语里混着中文"（`check-corpus.ts` 的语种纯度门禁盯着这一条）。
 *
 * **码的形状**：一个字母 + 三位数字（`E401` 这种），走的是 `FAULT_CODE_RE` 那一份判形 ——
 * 公开接口与快路只认这个形状，四位数或带连字符的码插进库也查不到。
 *
 * **幂等**：随机数用固定种子（`--seed`，默认 20261028），同一批参数每次生成同样的行，
 * 插库一律 `on conflict (code, product_line) do nothing` —— 连跑两次不会多出一行，
 * 也不会覆盖已经被人改过的行（D25：归档态只能靠 status，不能被脚本复活）。
 *
 * **状态默认 published**：模拟数据要能在公开接口 `GET /api/fault/:code` 和对话快路里查到，
 * 否则演示时只能看管理端。想造一批"等人审的草稿"用 `--status draft`。
 * 五语十列在生成阶段就全部非空，`check-corpus.ts` 的"published 缺语必红"不会被这批数据踩到。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/seed-faults-bulk.ts
 *   node --env-file-if-exists=.env scripts/seed-faults-bulk.ts --count 200 --status draft
 *   node --env-file-if-exists=.env scripts/seed-faults-bulk.ts --dry-run   # 只打印样例，不写库
 *
 * 不做的事：不 truncate、不 delete、不改任何既有行；清库是 `make reset` 的职责。
 * 也不写 `corpus/.fixtures/fault_codes.json`：那是 `make export-faults` 的单向快照。
 */

import { FAULT_CODE_RE } from "../src/core/fastpath.ts";
import { pool, query, tx } from "../src/db.ts";

type Lang = "zh" | "en" | "de" | "nl" | "es";
type Severity = "info" | "warn" | "fatal";
type ProductLine = "balcony" | "residential" | "cni";
type FaultStatus = "published" | "draft";

const LANGS: readonly Lang[] = ["zh", "en", "de", "nl", "es"];

/** 整数区间（写库前按 `decimals` 左移小数点）；采样步进 `step`。 */
interface Span {
  min: number;
  max: number;
  step: number;
}

interface Category {
  /** 故障族的内部标识，只用于日志 */
  key: string;
  /** 故障码前缀（一个字母一个族），码 = 前缀 + 三位序号（见 `CODE_START`） */
  prefix: string;
  severity: Severity;
  /** `--count 1000` 时的条数，实际按比例缩放 */
  base: number;
  /** 该族出现在哪些产品线上 */
  lines: readonly ProductLine[];
  /** 主指标：`{v}` */
  value: Span & { decimals: number };
  /** 持续时长：`{dur}`（单位写死在模板里：分钟 / 秒 / 毫秒 / 帧） */
  dur: Span;
  desc: Record<Lang, string>;
  act: Record<Lang, string>;
}

/* ────────────────────────── 机型（按产品线） ────────────────────────── */

const MODELS: Record<ProductLine, readonly string[]> = {
  balcony: ["WT-BK-600", "WT-BK-800", "WT-BK-1200"],
  residential: ["WT-RS-5K", "WT-RS-8K", "WT-RS-10K", "WT-RS-15K"],
  cni: ["WT-CNI-30K", "WT-CNI-50K", "WT-CNI-100K", "WT-CNI-215K"],
};

/**
 * 场景短语：五种语言都写成时间状语（德语要求第三格、西语用 "durante + 名词"），
 * 所以模板里统一以 "…发生于{ctx}。" / "This occurred during {ctx}." 收尾。
 */
const CONTEXTS: readonly Record<Lang, string>[] = [
  {
    zh: "首次并网自检",
    en: "the first grid-connection self-test",
    de: "der ersten Netzanmeldung",
    nl: "de eerste netinschakeling",
    es: "la primera autocomprobación de conexión",
  },
  {
    zh: "夜间满功率放电",
    en: "the night-time full-power discharge",
    de: "der nächtlichen Volllast-Entladung",
    nl: "het nachtelijke ontladen op vol vermogen",
    es: "la descarga nocturna a plena potencia",
  },
  {
    zh: "雷雨过后复电",
    en: "re-energisation after a thunderstorm",
    de: "der Wiederzuschaltung nach einem Gewitter",
    nl: "het opnieuw inschakelen na onweer",
    es: "la reconexión tras una tormenta",
  },
  {
    zh: "连续阴雨后的补电",
    en: "recharging after several overcast days",
    de: "des Nachladens nach mehreren trüben Tagen",
    nl: "het bijladen na meerdere grauwe dagen",
    es: "la recarga tras varios días nublados",
  },
  {
    zh: "夏季正午满发时段",
    en: "the summer noon peak-output window",
    de: "der Mittagsspitze im Sommer",
    nl: "het zomerse middagpiekvenster",
    es: "la franja de máxima producción del mediodía de verano",
  },
  {
    zh: "电网电压波动时段",
    en: "a period of grid voltage fluctuation",
    de: "einer Phase mit Netzspannungsschwankungen",
    nl: "een periode met netspanningsschommelingen",
    es: "un periodo de fluctuaciones de tensión de red",
  },
  {
    zh: "备用电源切换测试",
    en: "a backup-power changeover test",
    de: "eines Umschaltests auf Ersatzstrom",
    nl: "een omschakeltest naar noodstroom",
    es: "una prueba de conmutación a alimentación de reserva",
  },
  {
    zh: "固件升级后的重启",
    en: "the restart after a firmware update",
    de: "des Neustarts nach einem Firmware-Update",
    nl: "de herstart na een firmware-update",
    es: "el reinicio tras una actualización de firmware",
  },
];

/* ────────────────────────── 14 个故障族 ────────────────────────── */

/**
 * 每个前缀的序号起点。**必须是三位数**：`FAULT_CODE_RE`（`src/core/fastpath.ts`，公开接口
 * `/api/fault/:code` 与对话快路共用同一份判形）只认 "字母 + 2~3 位数字"，
 * 四位数的码插进库也查不到 —— 那是假数据。
 * 起点还刻意避开了既有种子码（E03 / E07 / E11 / F05 / F21 / C02）与测试夹具当"必须不存在"
 * 用的码（E99 / E123）：撞上了会让 `tests/chat-fastpath.test.ts` 的前提失效。
 */
const CODE_START: Record<string, number> = {
  E: 400,
  F: 300,
  G: 100,
  B: 100,
  A: 100,
  J: 100,
  K: 100,
  S: 100,
  P: 100,
  T: 100,
  C: 100,
  D: 100,
  W: 100,
  L: 100,
};

const CATEGORIES: readonly Category[] = [
  {
    key: "grid-overvoltage",
    prefix: "E",
    severity: "warn",
    base: 90,
    lines: ["balcony", "residential", "cni"],
    value: { min: 248, max: 262, step: 1, decimals: 0 },
    dur: { min: 3, max: 60, step: 3 },
    desc: {
      zh: "并网点电压超出允许上限。设备 {model} 检测到并网点电压为 {v} V，高于 253 V 的保护阈值并持续 {dur} 分钟，系统已停止向电网送电并上报该故障码。台区光伏装机集中、变压器分接头偏高或并网电缆过长都会造成这一现象。本次发生于{ctx}。",
      en: "Grid-connection voltage above the permitted limit. The unit {model} measured {v} V at the point of connection, above the 253 V protection threshold for {dur} min, so it stopped feeding the grid and reported this fault code. Dense PV penetration in the area, a high transformer tap setting or an oversized grid cable all cause this. This occurred during {ctx}.",
      de: "Netzspannung über dem zulässigen Grenzwert. Das Gerät {model} hat am Netzanschlusspunkt {v} V gemessen — über der Schutzschwelle von 253 V und dies für {dur} min — woraufhin die Einspeisung beendet und dieser Fehlercode gemeldet wurde. Dichte Photovoltaik im Gebiet, eine zu hoch gewählte Transformatoranzapfung oder ein zu langes Netzkabel verursachen das. Aufgetreten ist dies während {ctx}.",
      nl: "Netspanning boven de toegestane grens. Toestel {model} mat {v} V op het netaansluitpunt — boven de beveiligingsdrempel van 253 V, gedurende {dur} min — en stopte daarop de teruglevering met deze foutcode. Veel fotovoltaïek in de buurt, een te hoge aftakking van de transformator of een te lange netkabel veroorzaken dit. Dit trad op tijdens {ctx}.",
      es: "Tensión de red por encima del límite permitido. El equipo {model} midió {v} V en el punto de conexión —por encima del umbral de protección de 253 V y durante {dur} min—, por lo que dejó de entregar a la red y registró este código. La alta densidad fotovoltaica en la zona, una toma de transformador demasiado alta o un cable de red sobredimensionado lo provocan. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 用万用表测量并网点空载电压并与 {v} V 的记录对比；2. 检查并网电缆端子是否松动、线径是否符合手册；3. 电压长期高于 253 V 时联系电网公司调整变压器分接头，不要改设备参数绕过保护；4. 处理后复位并观察十分钟，仍报同一故障码时提交工单。",
      en: "1. Measure the open-circuit voltage at the point of connection and compare it with the recorded {v} V; 2. check the grid cable terminals for tightness and the conductor size against the manual; 3. if the voltage stays above 253 V, ask the grid operator to adjust the transformer tap instead of changing device parameters; 4. reset the unit, watch it for ten minutes and raise a ticket if the same code returns.",
      de: "1. Leerlaufspannung am Netzanschlusspunkt messen und mit den erfassten {v} V vergleichen; 2. Klemmen des Netzkabels auf festen Sitz und den Querschnitt gegen das Handbuch prüfen; 3. bleibt die Spannung über 253 V, den Netzbetreiber um Anpassung der Transformatoranzapfung bitten, statt Geräteparameter zu ändern; 4. zurücksetzen, zehn Minuten beobachten und bei erneutem Auftreten ein Ticket anlegen.",
      nl: "1. Meet de nullastspanning op het netaansluitpunt en vergelijk die met de gemeten {v} V; 2. controleer of de klemmen van de netkabel vastzitten en of de doorsnede klopt met de handleiding; 3. blijft de spanning boven 253 V, vraag de netbeheerder dan de aftakking aan te passen in plaats van toestelparameters te wijzigen; 4. reset, observeer tien minuten en maak een ticket aan als dezelfde code terugkomt.",
      es: "1. Mida la tensión en vacío en el punto de conexión y compárela con los {v} V registrados; 2. compruebe el apriete de los bornes del cable de red y la sección frente al manual; 3. si la tensión sigue por encima de 253 V, pida al operador de red que ajuste la toma del transformador en lugar de modificar parámetros; 4. reinicie, observe diez minutos y abra un ticket si el código reaparece.",
    },
  },
  {
    key: "grid-undervoltage",
    prefix: "F",
    severity: "warn",
    base: 70,
    lines: ["balcony", "residential", "cni"],
    value: { min: 190, max: 207, step: 1, decimals: 0 },
    dur: { min: 3, max: 60, step: 3 },
    desc: {
      zh: "并网点电压低于允许下限。设备 {model} 检测到并网点电压为 {v} V，低于 207 V 的保护阈值并持续 {dur} 分钟，系统停止送电并上报该故障码。常见原因是并网电缆接触电阻过大、台区负荷过重或上级线路检修。本次发生于{ctx}。",
      en: "Grid-connection voltage below the permitted limit. The unit {model} measured {v} V at the point of connection, below the 207 V protection threshold for {dur} min, so it stopped exporting and reported this fault code. Common causes are excessive contact resistance in the grid cable, an overloaded distribution transformer or upstream line works. This occurred during {ctx}.",
      de: "Netzspannung unter dem zulässigen Grenzwert. Das Gerät {model} hat am Netzanschlusspunkt {v} V gemessen — unter der Schutzschwelle von 207 V und dies für {dur} min — und die Einspeisung mit diesem Fehlercode beendet. Häufige Ursachen sind zu hohe Übergangswiderstände im Netzkabel, ein überlasteter Ortsnetztransformator oder Arbeiten an der vorgelagerten Leitung. Aufgetreten ist dies während {ctx}.",
      nl: "Netspanning onder de toegestane grens. Toestel {model} mat {v} V op het netaansluitpunt — onder de beveiligingsdrempel van 207 V, gedurende {dur} min — en stopte de levering met deze foutcode. Veelvoorkomende oorzaken zijn een te hoge overgangsweerstand in de netkabel, een overbelaste wijktrafo of werkzaamheden aan de bovenliggende lijn. Dit trad op tijdens {ctx}.",
      es: "Tensión de red por debajo del límite permitido. El equipo {model} midió {v} V en el punto de conexión —por debajo del umbral de protección de 207 V y durante {dur} min—, por lo que dejó de entregar y registró este código. Las causas habituales son una resistencia de contacto excesiva en el cable de red, un transformador de distribución sobrecargado o trabajos en la línea aguas arriba. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 测量并网点电压并与 {v} V 的记录对比；2. 检查并网开关与端子是否有氧化、发热痕迹；3. 询问业主同一台区其他用户是否也停电；4. 复位后观察十分钟，仍报同一故障码时提交工单并附电压记录。",
      en: "1. Measure the voltage at the point of connection and compare it with the recorded {v} V; 2. inspect the grid switch and terminals for oxidation or heat marks; 3. ask the owner whether other customers on the same transformer are also affected; 4. reset, watch for ten minutes and raise a ticket with the voltage log if the same code returns.",
      de: "1. Spannung am Netzanschlusspunkt messen und mit den erfassten {v} V vergleichen; 2. Netzschalter und Klemmen auf Oxidation und Hitzespuren prüfen; 3. beim Betreiber erfragen, ob weitere Kunden am selben Transformator betroffen sind; 4. zurücksetzen, zehn Minuten beobachten und bei erneutem Auftreten ein Ticket mit dem Spannungsprotokoll anlegen.",
      nl: "1. Meet de spanning op het netaansluitpunt en vergelijk die met de gemeten {v} V; 2. controleer de netschakelaar en klemmen op oxidatie en hittesporen; 3. vraag de eigenaar of andere klanten op dezelfde trafo ook hinder hebben; 4. reset, observeer tien minuten en maak een ticket aan met het spanningslog als de code terugkomt.",
      es: "1. Mida la tensión en el punto de conexión y compárela con los {v} V registrados; 2. revise el interruptor de red y los bornes en busca de oxidación o marcas de calor; 3. pregunte al propietario si otros clientes del mismo transformador también se ven afectados; 4. reinicie, observe diez minutos y abra un ticket con el registro de tensión si el código reaparece.",
    },
  },
  {
    key: "grid-overfrequency",
    prefix: "G",
    severity: "warn",
    base: 60,
    lines: ["balcony", "residential", "cni"],
    value: { min: 503, max: 518, step: 1, decimals: 1 },
    dur: { min: 2, max: 40, step: 2 },
    desc: {
      zh: "并网频率高于允许上限。设备 {model} 检测到并网频率为 {v} Hz，高于 50.2 Hz 的保护阈值并持续 {dur} 分钟，按并网规范停止送电并上报该故障码。成因多为台区发电过剩、电网切机或大负荷突然甩负荷。本次发生于{ctx}。",
      en: "Grid frequency above the permitted upper limit. The unit {model} measured {v} Hz, above the 50.2 Hz protection threshold for {dur} min, so it stopped exporting as the grid code requires and reported this fault code. Typical causes are surplus generation in the area, a grid-side generator trip or a large load rejection. This occurred during {ctx}.",
      de: "Netzfrequenz über dem zulässigen oberen Grenzwert. Das Gerät {model} hat {v} Hz gemessen — über der Schutzschwelle von 50,2 Hz und dies für {dur} min — und die Einspeisung normgerecht beendet sowie diesen Fehlercode gemeldet. Typische Ursachen sind Überschusserzeugung im Gebiet, die Abschaltung eines Kraftwerksblocks oder der plötzliche Wegfall einer großen Last. Aufgetreten ist dies während {ctx}.",
      nl: "Netfrequentie boven de toegestane bovengrens. Toestel {model} mat {v} Hz — boven de beveiligingsdrempel van 50,2 Hz, gedurende {dur} min — en stopte de levering volgens de netcode met deze foutcode. Typische oorzaken zijn een overschot aan opwek in de buurt, het afschakelen van een centrale of het plotseling wegvallen van een grote last. Dit trad op tijdens {ctx}.",
      es: "Frecuencia de red por encima del límite superior permitido. El equipo {model} midió {v} Hz —por encima del umbral de 50,2 Hz y durante {dur} min—, detuvo la entrega según el código de red y registró este código. Las causas típicas son un excedente de generación en la zona, la desconexión de un grupo generador o la pérdida súbita de una gran carga. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 记录故障码触发时间与频率曲线；2. 检查同一台区其他储能或逆变器是否同时停机；3. 频率恢复后等待五分钟，设备会自动重新并网；4. 反复出现时提交工单并附频率曲线截图，不要调整频率保护参数。",
      en: "1. Note the trigger time and the frequency curve; 2. check whether other storage units or inverters on the same transformer tripped at the same time; 3. wait five minutes after the frequency recovers and the unit reconnects automatically; 4. if it repeats, raise a ticket with a screenshot of the frequency curve and do not change the frequency protection settings.",
      de: "1. Auslösezeitpunkt und Frequenzverlauf dokumentieren; 2. prüfen, ob andere Speicher oder Wechselrichter am selben Transformator gleichzeitig abgeschaltet haben; 3. nach Rückkehr der Frequenz fünf Minuten warten, dann speist das Gerät automatisch wieder ein; 4. bei Wiederholung ein Ticket mit Screenshot des Frequenzverlaufs anlegen und die Frequenzschutzparameter nicht verändern.",
      nl: "1. Noteer het tijdstip van optreden en de frequentiecurve; 2. controleer of andere opslagsystemen of omvormers op dezelfde trafo tegelijk afschakelden; 3. wacht vijf minuten nadat de frequentie terug is, dan levert het toestel automatisch weer; 4. maak bij herhaling een ticket aan met een schermafbeelding van de frequentiecurve en wijzig de frequentiebeveiliging niet.",
      es: "1. Anote la hora del disparo y la curva de frecuencia; 2. compruebe si otros sistemas de almacenamiento u otros inversores del mismo transformador se desconectaron a la vez; 3. espere cinco minutos tras recuperarse la frecuencia y el equipo se reconecta solo; 4. si se repite, abra un ticket con una captura de la curva de frecuencia y no modifique los ajustes de protección de frecuencia.",
    },
  },
  {
    key: "cell-overvoltage",
    prefix: "B",
    severity: "warn",
    base: 90,
    lines: ["balcony", "residential", "cni"],
    value: { min: 355, max: 378, step: 1, decimals: 2 },
    dur: { min: 2, max: 30, step: 2 },
    desc: {
      zh: "电池单体电压高于允许上限。充电末端设备 {model} 检测到最高单体电压为 {v} V，高于 3.65 V 的保护阈值并持续 {dur} 分钟，系统停止充电并上报该故障码。电池长时间满电搁置、低温充电或单体一致性变差都会导致这一现象。本次发生于{ctx}。",
      en: "Battery cell voltage above the permitted limit. At the end of charging the unit {model} measured a maximum cell voltage of {v} V, above the 3.65 V protection threshold for {dur} min, so charging stopped and this fault code was reported. Leaving the battery full for a long time, charging at low temperature or drifting cell balance all cause this. This occurred during {ctx}.",
      de: "Zellspannung über dem zulässigen Grenzwert. Am Ende des Ladevorgangs hat das Gerät {model} eine höchste Zellspannung von {v} V gemessen — über der Schutzschwelle von 3,65 V und dies für {dur} min — woraufhin der Ladevorgang beendet und dieser Fehlercode gemeldet wurde. Langer Vollstand, Laden bei niedriger Temperatur oder nachlassende Zellbalance verursachen das. Aufgetreten ist dies während {ctx}.",
      nl: "Celspanning boven de toegestane grens. Aan het einde van het laden mat toestel {model} een hoogste celspanning van {v} V — boven de beveiligingsdrempel van 3,65 V, gedurende {dur} min — waarop het laden stopte en deze foutcode werd gemeld. Lang vol laten staan, laden bij lage temperatuur of afnemende celbalans veroorzaken dit. Dit trad op tijdens {ctx}.",
      es: "Tensión de celda por encima del límite permitido. Al final de la carga el equipo {model} midió una tensión máxima de celda de {v} V —por encima del umbral de 3,65 V y durante {dur} min—, por lo que detuvo la carga y registró este código. Dejar la batería llena mucho tiempo, cargar a baja temperatura o un desequilibrio creciente entre celdas lo provocan. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 在调试页面读取最高单体电压与电池温度；2. 暂停充电并让电池静置三十分钟，观察单体电压是否回落；3. 单体压差超过零点零五伏时做一次均衡；4. 复位后观察一个完整充放循环，仍报同一故障码时提交工单并附单体电压截图。",
      en: "1. Read the highest cell voltage and the battery temperature on the commissioning page; 2. pause charging and let the battery rest for thirty minutes to see whether the cell voltage falls back; 3. run a balancing cycle if the spread between cells exceeds 0.05 V; 4. reset and watch one full charge and discharge cycle, and raise a ticket with the cell voltage screenshot if the same code returns.",
      de: "1. Höchste Zellspannung und Batterietemperatur auf der Inbetriebnahmeseite ablesen; 2. Ladevorgang pausieren und die Batterie dreißig Minuten ruhen lassen, um zu sehen, ob die Zellspannung zurückgeht; 3. bei einer Zelldifferenz über 0,05 V einen Balanciervorgang starten; 4. zurücksetzen, einen vollständigen Lade- und Entladezyklus beobachten und bei erneutem Auftreten ein Ticket mit Screenshot der Zellspannungen anlegen.",
      nl: "1. Lees de hoogste celspanning en de batterijtemperatuur af op de inbedrijfstellingspagina; 2. pauzeer het laden en laat de batterij dertig minuten rusten om te zien of de celspanning terugzakt; 3. start een balanceercyclus als het verschil tussen cellen boven 0,05 V komt; 4. reset en bekijk een volledige laad- en ontlaadcyclus, en maak een ticket aan met de schermafbeelding als de code terugkomt.",
      es: "1. Lea la tensión de celda más alta y la temperatura de la batería en la página de puesta en marcha; 2. pause la carga y deje reposar la batería treinta minutos para ver si la tensión baja; 3. ejecute un ciclo de equilibrado si la diferencia entre celdas supera 0,05 V; 4. reinicie, observe un ciclo completo de carga y descarga y abra un ticket con la captura de tensiones si el código reaparece.",
    },
  },
  {
    key: "cell-undervoltage",
    prefix: "A",
    severity: "warn",
    base: 70,
    lines: ["balcony", "residential", "cni"],
    value: { min: 270, max: 295, step: 1, decimals: 2 },
    dur: { min: 2, max: 30, step: 2 },
    desc: {
      zh: "电池单体电压低于允许下限。放电末端设备 {model} 检测到最低单体电压为 {v} V，低于 3.00 V 的保护阈值并持续 {dur} 分钟，系统停止放电并上报该故障码。可用容量标定偏差、长期未满充或单体一致性变差都会导致这一现象。本次发生于{ctx}。",
      en: "Battery cell voltage below the permitted limit. At the end of discharge the unit {model} measured a minimum cell voltage of {v} V, below the 3.00 V protection threshold for {dur} min, so discharging stopped and this fault code was reported. A mis-calibrated usable capacity, long periods without a full charge or drifting cell balance all cause this. This occurred during {ctx}.",
      de: "Zellspannung unter dem zulässigen Grenzwert. Am Ende der Entladung hat das Gerät {model} eine niedrigste Zellspannung von {v} V gemessen — unter der Schutzschwelle von 3,00 V und dies für {dur} min — woraufhin die Entladung beendet und dieser Fehlercode gemeldet wurde. Falsch kalibrierte Nutzkapazität, lange Zeit ohne Vollladung oder nachlassende Zellbalance verursachen das. Aufgetreten ist dies während {ctx}.",
      nl: "Celspanning onder de toegestane grens. Aan het einde van het ontladen mat toestel {model} een laagste celspanning van {v} V — onder de beveiligingsdrempel van 3,00 V, gedurende {dur} min — waarop het ontladen stopte en deze foutcode werd gemeld. Een verkeerd gekalibreerde bruikbare capaciteit, langdurig niet volledig laden of afnemende celbalans veroorzaken dit. Dit trad op tijdens {ctx}.",
      es: "Tensión de celda por debajo del límite permitido. Al final de la descarga el equipo {model} midió una tensión mínima de celda de {v} V —por debajo del umbral de 3,00 V y durante {dur} min—, por lo que detuvo la descarga y registró este código. Una capacidad útil mal calibrada, largos periodos sin carga completa o un desequilibrio creciente entre celdas lo provocan. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 在调试页面读取最低单体电压与剩余电量；2. 立即安排一次完整充电，不要继续深度放电；3. 单体压差超过零点零五伏时做一次均衡并复测容量；4. 复位后观察一个完整充放循环，仍报同一故障码时提交工单并附单体电压截图。",
      en: "1. Read the lowest cell voltage and the state of charge on the commissioning page; 2. schedule a full charge right away and avoid further deep discharge; 3. if the spread between cells exceeds 0.05 V, run a balancing cycle and re-check the capacity; 4. reset and watch one full charge and discharge cycle, and raise a ticket with the cell voltage screenshot if the same code returns.",
      de: "1. Niedrigste Zellspannung und Ladezustand auf der Inbetriebnahmeseite ablesen; 2. umgehend eine Vollladung einplanen und keine weitere Tiefentladung zulassen; 3. bei einer Zelldifferenz über 0,05 V einen Balanciervorgang starten und die Kapazität nachmessen; 4. zurücksetzen, einen vollständigen Lade- und Entladezyklus beobachten und bei erneutem Auftreten ein Ticket mit Screenshot der Zellspannungen anlegen.",
      nl: "1. Lees de laagste celspanning en de laadtoestand af op de inbedrijfstellingspagina; 2. plan direct een volledige lading en voorkom verder diep ontladen; 3. start bij een verschil boven 0,05 V een balanceercyclus en meet de capaciteit opnieuw; 4. reset en bekijk een volledige laad- en ontlaadcyclus, en maak een ticket aan met de schermafbeelding als de code terugkomt.",
      es: "1. Lea la tensión de celda más baja y el estado de carga en la página de puesta en marcha; 2. programe de inmediato una carga completa y evite seguir descargando en profundidad; 3. si la diferencia entre celdas supera 0,05 V, ejecute un equilibrado y vuelva a medir la capacidad; 4. reinicie, observe un ciclo completo y abra un ticket con la captura si el código reaparece.",
    },
  },
  {
    key: "battery-low-temperature",
    prefix: "J",
    severity: "warn",
    base: 60,
    lines: ["balcony", "residential", "cni"],
    value: { min: -120, max: 20, step: 5, decimals: 1 },
    dur: { min: 5, max: 60, step: 5 },
    desc: {
      zh: "电池温度低于允许充电下限。设备 {model} 检测到电池最低温度为 {v} °C，低于 0 °C 的充电门槛，系统禁止充电并上报该故障码。低温充电会在负极析锂并永久损伤容量，因此这是保护动作而不是设备故障。本次发生于{ctx}。",
      en: "Battery temperature below the permitted charging limit. The unit {model} measured a minimum battery temperature of {v} °C, below the 0 °C charging threshold, so charging was blocked and this fault code reported. Charging below freezing plates lithium on the anode and permanently reduces capacity, so this is a protective action rather than an equipment failure. This occurred during {ctx}.",
      de: "Batterietemperatur unter der zulässigen Ladegrenze. Das Gerät {model} hat eine niedrigste Batterietemperatur von {v} °C gemessen — unter der Ladeschwelle von 0 °C — woraufhin der Ladevorgang gesperrt und dieser Fehlercode gemeldet wurde. Laden unter dem Gefrierpunkt führt zu Lithiumplating an der Anode und dauerhaftem Kapazitätsverlust; das ist daher eine Schutzmaßnahme und kein Gerätedefekt. Aufgetreten ist dies während {ctx}.",
      nl: "Batterijtemperatuur onder de laadgrens. Toestel {model} mat een laagste batterijtemperatuur van {v} °C — onder de laaddrempel van 0 °C — waarop het laden werd geblokkeerd en deze foutcode werd gemeld. Laden onder het vriespunt veroorzaakt lithiumplating op de anode en permanent capaciteitsverlies; dit is dus een beveiligingsingreep en geen defect. Dit trad op tijdens {ctx}.",
      es: "Temperatura de la batería por debajo del límite de carga. El equipo {model} midió una temperatura mínima de batería de {v} °C —por debajo del umbral de carga de 0 °C—, bloqueó la carga y registró este código. Cargar bajo cero provoca deposición de litio en el ánodo y pérdida permanente de capacidad, así que es una actuación de protección y no una avería. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 确认电池仓环境温度与 {v} °C 的记录；2. 有加热功能时先通电加热，等电池温度回到 5 °C 以上再充电；3. 没有加热功能时暂停充电并告知业主等待自然回温；4. 温度长期低于零度时提交工单评估加装保温或加热方案。",
      en: "1. Confirm the ambient temperature in the battery compartment against the recorded {v} °C; 2. if heating is fitted, power it and wait until the battery is above 5 °C before charging; 3. without heating, pause charging and tell the owner to wait until it warms up naturally; 4. if the temperature stays below freezing for long periods, raise a ticket to assess insulation or a heater.",
      de: "1. Umgebungstemperatur im Batteriefach prüfen und mit den erfassten {v} °C vergleichen; 2. ist eine Heizung vorhanden, diese einschalten und erst laden, wenn die Batterie über 5 °C liegt; 3. ohne Heizung den Ladevorgang pausieren und dem Betreiber mitteilen, dass die Batterie erst aufwärmen muss; 4. bleibt die Temperatur dauerhaft unter dem Gefrierpunkt, ein Ticket zur Prüfung von Dämmung oder Heizung anlegen.",
      nl: "1. Controleer de omgevingstemperatuur in het batterijvak en vergelijk die met de gemeten {v} °C; 2. is er verwarming, schakel die in en laad pas als de batterij boven 5 °C is; 3. zonder verwarming het laden pauzeren en de eigenaar laten wachten tot de batterij opwarmt; 4. blijft de temperatuur lang onder nul, maak dan een ticket aan voor isolatie of een verwarmingselement.",
      es: "1. Confirme la temperatura ambiente del compartimento de baterías frente a los {v} °C registrados; 2. si hay calefacción, actívela y espere a que la batería supere 5 °C antes de cargar; 3. sin calefacción, pause la carga y avise al propietario de que debe esperar a que se tempere; 4. si la temperatura permanece bajo cero mucho tiempo, abra un ticket para valorar aislamiento o calefactor.",
    },
  },
  {
    key: "battery-high-temperature",
    prefix: "K",
    severity: "warn",
    base: 70,
    lines: ["balcony", "residential", "cni"],
    value: { min: 460, max: 620, step: 5, decimals: 1 },
    dur: { min: 3, max: 45, step: 3 },
    desc: {
      zh: "电池温度高于允许上限。设备 {model} 检测到电池最高温度为 {v} °C，高于 45 °C 的保护阈值并持续 {dur} 分钟，系统限制充放电功率并上报该故障码。电池仓通风不良、夏季暴晒或风扇失效都会导致这一现象。本次发生于{ctx}。",
      en: "Battery temperature above the permitted limit. The unit {model} measured a maximum battery temperature of {v} °C, above the 45 °C protection threshold for {dur} min, so charging and discharging power was limited and this fault code reported. Poor ventilation in the battery compartment, summer solar gain or a failed fan all cause this. This occurred during {ctx}.",
      de: "Batterietemperatur über dem zulässigen Grenzwert. Das Gerät {model} hat eine höchste Batterietemperatur von {v} °C gemessen — über der Schutzschwelle von 45 °C und dies für {dur} min — woraufhin Lade- und Entladeleistung begrenzt und dieser Fehlercode gemeldet wurde. Schlechte Belüftung des Batteriefachs, Sonneneinstrahlung im Sommer oder ein ausgefallener Lüfter verursachen das. Aufgetreten ist dies während {ctx}.",
      nl: "Batterijtemperatuur boven de toegestane grens. Toestel {model} mat een hoogste batterijtemperatuur van {v} °C — boven de beveiligingsdrempel van 45 °C, gedurende {dur} min — waarop laad- en ontlaadvermogen werd begrensd en deze foutcode werd gemeld. Slechte ventilatie van het batterijvak, zonnestraling in de zomer of een defecte ventilator veroorzaken dit. Dit trad op tijdens {ctx}.",
      es: "Temperatura de la batería por encima del límite permitido. El equipo {model} midió una temperatura máxima de batería de {v} °C —por encima del umbral de 45 °C y durante {dur} min—, limitó la potencia de carga y descarga y registró este código. La mala ventilación del compartimento, la radiación solar en verano o un ventilador averiado lo provocan. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 检查电池仓通风口是否被遮挡、环境温度是否过高；2. 清理滤网与风扇叶片，确认风扇能转；3. 暂停充放电并把电池温度降到 35 °C 以下；4. 复位后观察温度曲线，仍报同一故障码时提交工单并附温度记录。",
      en: "1. Check that the battery compartment vents are not blocked and that the ambient temperature is not too high; 2. clean the filter and fan blades and confirm the fan turns; 3. pause charging and discharging and let the battery cool below 35 °C; 4. reset, watch the temperature curve and raise a ticket with the log if the same code returns.",
      de: "1. Prüfen, ob die Lüftungsöffnungen des Batteriefachs frei sind und die Umgebungstemperatur nicht zu hoch ist; 2. Filter und Lüfterblätter reinigen und prüfen, ob der Lüfter läuft; 3. Laden und Entladen pausieren und die Batterie unter 35 °C abkühlen lassen; 4. zurücksetzen, den Temperaturverlauf beobachten und bei erneutem Auftreten ein Ticket mit dem Protokoll anlegen.",
      nl: "1. Controleer of de ventilatieopeningen van het batterijvak vrij zijn en de omgevingstemperatuur niet te hoog is; 2. reinig filter en ventilatorbladen en controleer of de ventilator draait; 3. pauzeer laden en ontladen en laat de batterij onder 35 °C komen; 4. reset, bekijk de temperatuurcurve en maak een ticket aan met het log als de code terugkomt.",
      es: "1. Compruebe que las rejillas del compartimento de baterías no estén tapadas y que la temperatura ambiente no sea excesiva; 2. limpie el filtro y las palas del ventilador y confirme que gira; 3. pause la carga y la descarga y deje que la batería baje de 35 °C; 4. reinicie, observe la curva de temperatura y abra un ticket con el registro si el código reaparece.",
    },
  },
  {
    key: "insulation-low",
    prefix: "S",
    severity: "fatal",
    base: 90,
    lines: ["balcony", "residential"],
    value: { min: 15, max: 95, step: 5, decimals: 2 },
    dur: { min: 1, max: 1, step: 1 },
    desc: {
      zh: "直流侧对地绝缘阻抗低于一兆欧。设备 {model} 在并网自检中测得绝缘阻抗为 {v} MΩ，低于 1.00 MΩ 的安全门槛，拒绝并网并上报该故障码。组串接头受潮、电缆破损、组件进水或接地线松脱都可能造成这一现象。本次发生于{ctx}。",
      en: "Insulation resistance from the DC side to earth below one megaohm. During the grid-connection self-test the unit {model} measured {v} MΩ, below the 1.00 MΩ safety threshold, refused to connect and reported this fault code. Damp string connectors, damaged cable, water ingress in a module or a loose earth conductor can all cause this. This occurred during {ctx}.",
      de: "Isolationswiderstand der Gleichstromseite gegen Erde unter einem Megaohm. Beim Netzanschluss-Selbsttest hat das Gerät {model} {v} MΩ gemessen — unter der Sicherheitsschwelle von 1,00 MΩ — die Netzanmeldung abgelehnt und diesen Fehlercode gemeldet. Feuchte String-Steckverbinder, beschädigte Kabel, Wasser im Modul oder ein loser Schutzleiter können das verursachen. Aufgetreten ist dies während {ctx}.",
      nl: "Isolatieweerstand van de gelijkstroomzijde naar aarde onder één megaohm. Tijdens de zelftest voor netinschakeling mat toestel {model} {v} MΩ — onder de veiligheidsdrempel van 1,00 MΩ — weigerde de aansluiting en meldde deze foutcode. Vochtige stringstekkers, beschadigde kabel, water in een module of een losse aardgeleider kunnen dit veroorzaken. Dit trad op tijdens {ctx}.",
      es: "Resistencia de aislamiento del lado de continua respecto a tierra inferior a un megaohmio. Durante la autocomprobación de conexión el equipo {model} midió {v} MΩ —por debajo del umbral de seguridad de 1,00 MΩ—, rechazó la conexión y registró este código. Conectores de string húmedos, cable dañado, agua dentro de un módulo o un conductor de tierra flojo pueden provocarlo. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 断开交流与直流开关，等待指示灯熄灭；2. 用兆欧表逐串测量组串对地阻抗，找出低于一兆欧的那一串；3. 检查该串接头是否受潮、电缆是否破损、组件接线盒是否进水；4. 处理完成后复位等待自检通过，仍报同一故障码时提交工单并附逐串测量记录。",
      en: "1. Open the AC and DC switches and wait for the indicators to go out; 2. measure every string to earth with an insulation tester and find the string below one megaohm; 3. check that string for damp connectors, damaged cable and water in the module junction box; 4. after the repair, reset and wait for the self-test to pass, and raise a ticket with the per-string measurements if the code returns.",
      de: "1. Wechsel- und Gleichstromschalter öffnen und warten, bis die Anzeigen erlöschen; 2. jeden String mit einem Isolationsmessgerät gegen Erde messen und den String unter einem Megaohm finden; 3. diesen String auf feuchte Steckverbinder, beschädigte Kabel und Wasser in der Anschlussdose prüfen; 4. nach der Reparatur zurücksetzen, den Selbsttest abwarten und bei erneutem Auftreten ein Ticket mit den Messwerten je String anlegen.",
      nl: "1. Open de wisselstroom- en gelijkstroomschakelaar en wacht tot de indicatoren doven; 2. meet elke string tegen aarde met een isolatiemeter en zoek de string onder één megaohm; 3. controleer die string op vochtige stekkers, beschadigde kabel en water in de aansluitdoos; 4. reset na de reparatie, wacht de zelftest af en maak een ticket aan met de meetwaarden per string als de code terugkomt.",
      es: "1. Abra los interruptores de alterna y de continua y espere a que los indicadores se apaguen; 2. mida cada string contra tierra con un medidor de aislamiento y localice el que esté por debajo de un megaohmio; 3. revise ese string en busca de conectores húmedos, cable dañado y agua en la caja de conexiones; 4. tras la reparación, reinicie y espere la autocomprobación; si el código reaparece, abra un ticket con las mediciones por string.",
    },
  },
  {
    key: "power-module-overcurrent",
    prefix: "P",
    severity: "fatal",
    base: 70,
    lines: ["residential", "cni"],
    value: { min: 42, max: 135, step: 1, decimals: 0 },
    dur: { min: 2, max: 40, step: 2 },
    desc: {
      zh: "功率模块过流保护动作。设备 {model} 检测到功率模块峰值电流达到 {v} A，持续 {dur} 毫秒后触发硬件过流保护并停机，上报该故障码。负载侧短路、电网瞬时跌落或驱动板误动作都可能造成这一现象。本次发生于{ctx}。",
      en: "Power module overcurrent protection. The unit {model} measured a peak module current of {v} A and, after {dur} ms, the hardware overcurrent protection tripped and stopped the unit with this fault code. A short circuit on the load side, a momentary grid dip or a spurious gate-driver action can all cause this. This occurred during {ctx}.",
      de: "Überstromschutz des Leistungsmoduls. Das Gerät {model} hat einen Spitzenstrom von {v} A im Leistungsmodul gemessen; nach {dur} ms hat der Hardware-Überstromschutz ausgelöst, das Gerät gestoppt und diesen Fehlercode gemeldet. Ein Kurzschluss auf der Lastseite, ein kurzzeitiger Netzspannungseinbruch oder ein Fehlverhalten des Treibers können das verursachen. Aufgetreten ist dies während {ctx}.",
      nl: "Overstroombeveiliging van de vermogensmodule. Toestel {model} mat een piekstroom van {v} A in de vermogensmodule; na {dur} ms greep de hardwarematige overstroombeveiliging in, stopte het toestel en meldde deze foutcode. Een kortsluiting aan de lastzijde, een korte netspanningsdip of een foutieve aansturing van de gate-driver kunnen dit veroorzaken. Dit trad op tijdens {ctx}.",
      es: "Protección de sobrecorriente del módulo de potencia. El equipo {model} midió una corriente de pico de {v} A en el módulo y, tras {dur} ms, la protección hardware de sobrecorriente disparó, detuvo el equipo y registró este código. Un cortocircuito en el lado de carga, una caída momentánea de red o un disparo indebido del driver pueden provocarlo. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 断开交流与直流开关，禁止带电插拔功率线；2. 检查负载侧接线是否短路、端子是否打火发黑；3. 检查电网侧是否有瞬时跌落记录，与业主确认同一时段其他设备是否异常；4. 排除外部原因后复位并空载试运行十分钟，仍报同一故障码时提交工单并附故障录波。",
      en: "1. Open the AC and DC switches and never unplug power cables while live; 2. check the load-side wiring for short circuits and the terminals for arcing or blackening; 3. look for a recorded grid dip and ask the owner whether other equipment misbehaved at the same time; 4. once external causes are ruled out, reset and run idle for ten minutes, and raise a ticket with the fault record if the code returns.",
      de: "1. Wechsel- und Gleichstromschalter öffnen und Leistungskabel niemals unter Spannung trennen; 2. lastseitige Verkabelung auf Kurzschluss und Klemmen auf Lichtbogen- oder Schwärzungsspuren prüfen; 3. nach einem Netzspannungseinbruch im Protokoll suchen und beim Betreiber erfragen, ob andere Geräte zur selben Zeit gestört waren; 4. nach Ausschluss äußerer Ursachen zurücksetzen und zehn Minuten im Leerlauf testen; bei erneutem Auftreten ein Ticket mit dem Störschrieb anlegen.",
      nl: "1. Open de wisselstroom- en gelijkstroomschakelaar en trek vermogenskabels nooit onder spanning los; 2. controleer de bedrading aan de lastzijde op kortsluiting en de klemmen op vonkvorming of zwarte plekken; 3. zoek in het log naar een netspanningsdip en vraag de eigenaar of andere toestellen op dat moment stoorden; 4. reset na het uitsluiten van externe oorzaken en test tien minuten onbelast; maak bij herhaling een ticket aan met de storingsregistratie.",
      es: "1. Abra los interruptores de alterna y de continua y no desconecte nunca cables de potencia en tensión; 2. revise el cableado del lado de carga por cortocircuitos y los bornes por arcos o marcas negras; 3. busque una caída de red registrada y pregunte al propietario si otros equipos fallaron a la misma hora; 4. descartadas las causas externas, reinicie y pruebe en vacío diez minutos; si el código reaparece, abra un ticket con el registro de falta.",
    },
  },
  {
    key: "inverter-overtemperature",
    prefix: "T",
    severity: "warn",
    base: 80,
    lines: ["balcony", "residential", "cni"],
    value: { min: 780, max: 960, step: 1, decimals: 1 },
    dur: { min: 5, max: 45, step: 5 },
    desc: {
      zh: "逆变器过温降额。设备 {model} 检测到散热片温度为 {v} °C，高于 85 °C 的降额阈值并持续 {dur} 分钟，系统先降低输出功率，仍超温则停机并上报该故障码。散热片积灰、安装位置通风不良或环境温度过高都会导致这一现象。本次发生于{ctx}。",
      en: "Inverter overtemperature derating. The unit {model} measured a heat-sink temperature of {v} °C, above the 85 °C derating threshold for {dur} min, so output power was reduced first and the unit shut down if the temperature stayed high, reporting this fault code. Dust on the heat sink, a poorly ventilated mounting position or high ambient temperature all cause this. This occurred during {ctx}.",
      de: "Übertemperatur am Wechselrichter mit Leistungsreduktion. Das Gerät {model} hat eine Kühlkörpertemperatur von {v} °C gemessen — über der Reduktionsschwelle von 85 °C und dies für {dur} min — woraufhin die Ausgangsleistung zuerst reduziert und bei anhaltender Hitze abgeschaltet wurde, mit Meldung dieses Fehlercodes. Staub auf dem Kühlkörper, ein schlecht belüfteter Montageort oder hohe Umgebungstemperatur verursachen das. Aufgetreten ist dies während {ctx}.",
      nl: "Overtemperatuur bij de omvormer met terugregeling. Toestel {model} mat een koelplaattemperatuur van {v} °C — boven de reductiedrempel van 85 °C, gedurende {dur} min — waarop het uitgangsvermogen eerst werd verlaagd en het toestel bij aanhoudende hitte uitschakelde met deze foutcode. Stof op de koelplaat, een slecht geventileerde montageplaats of een hoge omgevingstemperatuur veroorzaken dit. Dit trad op tijdens {ctx}.",
      es: "Sobrecalentamiento del inversor con reducción de potencia. El equipo {model} midió una temperatura del disipador de {v} °C —por encima del umbral de reducción de 85 °C y durante {dur} min—, redujo primero la potencia y se apagó si el calor persistía, registrando este código. El polvo en el disipador, una ubicación mal ventilada o una temperatura ambiente alta lo provocan. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 检查设备周围是否堆放杂物、是否被阳光直射；2. 清理散热片灰尘并保证顶部三十厘米无遮挡；3. 断开交流开关，等散热片温度降到 45 °C 以下；4. 复位后观察输出功率曲线，再次出现时提交工单并附温度记录。",
      en: "1. Check that nothing is stacked around the unit and that it is not in direct sunlight; 2. clean dust off the heat sink and keep thirty centimetres clear above the unit; 3. open the AC switch and wait until the heat sink drops below 45 °C; 4. reset and watch the output power curve, and raise a ticket with the temperature log if the code returns.",
      de: "1. Prüfen, ob um das Gerät etwas gelagert wird und ob es direkter Sonne ausgesetzt ist; 2. Staub vom Kühlkörper entfernen und dreißig Zentimeter über dem Gerät frei halten; 3. den Wechselstromschalter öffnen und warten, bis der Kühlkörper unter 45 °C fällt; 4. zurücksetzen, den Verlauf der Ausgangsleistung beobachten und bei erneutem Auftreten ein Ticket mit dem Temperaturprotokoll anlegen.",
      nl: "1. Controleer of er spullen rond het toestel staan en of het in direct zonlicht hangt; 2. verwijder stof van de koelplaat en houd dertig centimeter boven het toestel vrij; 3. open de wisselstroomschakelaar en wacht tot de koelplaat onder 45 °C zakt; 4. reset, bekijk de curve van het uitgangsvermogen en maak een ticket aan met het temperatuurlog als de code terugkomt.",
      es: "1. Compruebe que no haya objetos apilados alrededor del equipo ni luz solar directa; 2. limpie el polvo del disipador y deje treinta centímetros libres por encima; 3. abra el interruptor de alterna y espere a que el disipador baje de 45 °C; 4. reinicie, observe la curva de potencia de salida y abra un ticket con el registro de temperatura si el código reaparece.",
    },
  },
  {
    key: "bms-communication-timeout",
    prefix: "C",
    severity: "warn",
    base: 100,
    lines: ["balcony", "residential", "cni"],
    value: { min: 3, max: 60, step: 3, decimals: 0 },
    dur: { min: 1, max: 1, step: 1 },
    desc: {
      zh: "电池管理系统通讯超时。设备 {model} 连续 {v} 帧没有收到电池管理系统的心跳报文，超过 3 秒的判据后停止充放电并上报该故障码。通讯线松动、地址拨码重复、终端电阻缺失或电池休眠都会导致这一现象。本次发生于{ctx}。",
      en: "Battery management system communication timeout. The unit {model} missed {v} consecutive heartbeat frames from the battery management system, exceeded the 3-second criterion, stopped charging and discharging and reported this fault code. A loose communication cable, duplicate address switches, a missing termination resistor or a sleeping battery can all cause this. This occurred during {ctx}.",
      de: "Zeitüberschreitung in der Kommunikation mit dem Batteriemanagement. Das Gerät {model} hat {v} Heartbeat-Nachrichten des Batteriemanagements in Folge nicht empfangen, das Kriterium von 3 Sekunden überschritten, Laden und Entladen gestoppt und diesen Fehlercode gemeldet. Ein loses Kommunikationskabel, doppelte Adressschalter, ein fehlender Abschlusswiderstand oder eine schlafende Batterie können das verursachen. Aufgetreten ist dies während {ctx}.",
      nl: "Time-out in de communicatie met het batterijbeheersysteem. Toestel {model} heeft {v} heartbeat-berichten van het batterijbeheersysteem op rij gemist, het criterium van 3 seconden overschreden, laden en ontladen gestopt en deze foutcode gemeld. Een losse communicatiekabel, dubbele adresschakelaars, een ontbrekende afsluitweerstand of een slapende batterij kunnen dit veroorzaken. Dit trad op tijdens {ctx}.",
      es: "Tiempo de espera agotado en la comunicación con el BMS. El equipo {model} perdió {v} tramas de latido consecutivas del sistema de gestión de batería, superó el criterio de 3 segundos, detuvo la carga y la descarga y registró este código. Un cable de comunicación flojo, direcciones duplicadas, una resistencia de terminación ausente o una batería en reposo pueden provocarlo. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 检查电池与逆变器之间通讯线两端是否插紧、屏蔽层是否接地；2. 确认同一条总线没有重复地址拨码；3. 检查总线两端终端电阻是否为 120 欧姆；4. 长按电池电源键唤醒并复位，仍报同一故障码时提交工单并附通讯线型号与拨码照片。",
      en: "1. Check that both ends of the communication cable between battery and inverter are fully seated and that the shield is earthed; 2. make sure no address switch is set twice on the same bus; 3. check that both ends of the bus carry a 120 ohm termination resistor; 4. press and hold the battery power key to wake it, reset, and raise a ticket with the cable type and a photo of the switches if the code returns.",
      de: "1. Prüfen, ob beide Enden des Kommunikationskabels zwischen Batterie und Wechselrichter fest sitzen und die Schirmung geerdet ist; 2. sicherstellen, dass auf demselben Bus keine Adresse doppelt gesetzt ist; 3. prüfen, ob an beiden Busenden ein Abschlusswiderstand von 120 Ohm sitzt; 4. die Einschalttaste der Batterie gedrückt halten, zurücksetzen und bei erneutem Auftreten ein Ticket mit Kabeltyp und Foto der Schalter anlegen.",
      nl: "1. Controleer of beide uiteinden van de communicatiekabel tussen batterij en omvormer goed vastzitten en of de afscherming geaard is; 2. zorg dat geen adres dubbel is ingesteld op dezelfde bus; 3. controleer of aan beide busuiteinden een afsluitweerstand van 120 ohm zit; 4. houd de aan/uit-toets van de batterij ingedrukt, reset en maak een ticket aan met het kabeltype en een foto van de schakelaars als de code terugkomt.",
      es: "1. Compruebe que ambos extremos del cable de comunicación entre batería e inversor estén bien insertados y que la malla esté conectada a tierra; 2. asegúrese de que no haya direcciones duplicadas en el mismo bus; 3. verifique que ambos extremos del bus tengan una resistencia de terminación de 120 ohmios; 4. mantenga pulsada la tecla de encendido de la batería, reinicie y abra un ticket con el tipo de cable y una foto de los conmutadores si el código reaparece.",
    },
  },
  {
    key: "cloud-communication-lost",
    prefix: "D",
    severity: "info",
    base: 60,
    lines: ["balcony", "residential", "cni"],
    value: { min: 3, max: 90, step: 3, decimals: 0 },
    dur: { min: 1, max: 1, step: 1 },
    desc: {
      zh: "设备与能源管理平台通讯中断。设备 {model} 已连续 {v} 分钟无法与云端 EMS 建立连接，本地控制策略继续运行并上报该故障码。路由器重启、SIM 卡欠费、运营商信号弱或防火墙改端口都会导致这一现象。本次发生于{ctx}。",
      en: "Communication with the energy management platform lost. The unit {model} has been unable to reach the cloud EMS for {v} minutes; local control keeps running and this fault code was reported. A router reboot, an unpaid SIM card, weak mobile coverage or a firewall port change can all cause this. This occurred during {ctx}.",
      de: "Kommunikation mit der Energiemanagement-Plattform unterbrochen. Das Gerät {model} erreicht das Cloud-EMS seit {v} Minuten nicht; die lokale Regelung läuft weiter und dieser Fehlercode wurde gemeldet. Ein Router-Neustart, eine nicht bezahlte SIM-Karte, schwacher Mobilfunkempfang oder eine geänderte Firewall-Freigabe können das verursachen. Aufgetreten ist dies während {ctx}.",
      nl: "Communicatie met het energiebeheerplatform verbroken. Toestel {model} bereikt het cloud-EMS al {v} minuten niet; de lokale regeling blijft draaien en deze foutcode werd gemeld. Een herstart van de router, een niet-betaalde simkaart, zwakke mobiele dekking of een gewijzigde firewallpoort kunnen dit veroorzaken. Dit trad op tijdens {ctx}.",
      es: "Comunicación con la plataforma de gestión energética interrumpida. El equipo {model} lleva {v} minutos sin alcanzar el EMS en la nube; el control local sigue funcionando y se registró este código. Un reinicio del router, una tarjeta SIM impagada, cobertura móvil débil o un cambio de puerto en el cortafuegos pueden provocarlo. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 检查现场路由器与光猫指示灯，确认宽带在线；2. 登录调试页面查看 SIM 卡状态与信号强度；3. 重启通讯模块后等待五分钟，观察是否能重新上线；4. 仍无法上线时提交工单并附调试页面截图，同时说明本地运行不受影响。",
      en: "1. Check the router and ONT indicators on site to confirm the broadband link is up; 2. log in to the commissioning page and check SIM status and signal strength; 3. restart the communication module, wait five minutes and see whether it comes back online; 4. if it does not, raise a ticket with the commissioning screenshot and note that local operation is unaffected.",
      de: "1. Anzeigen von Router und Glasfasermodem vor Ort prüfen und bestätigen, dass die Breitbandverbindung steht; 2. auf der Inbetriebnahmeseite SIM-Status und Signalstärke kontrollieren; 3. das Kommunikationsmodul neu starten, fünf Minuten warten und prüfen, ob es wieder online geht; 4. gelingt das nicht, ein Ticket mit Screenshot anlegen und angeben, dass der lokale Betrieb davon unberührt ist.",
      nl: "1. Controleer de indicatoren van router en glasmodem ter plaatse en bevestig dat de breedbandverbinding actief is; 2. log in op de inbedrijfstellingspagina en controleer simstatus en signaalsterkte; 3. herstart de communicatiemodule, wacht vijf minuten en kijk of hij weer online komt; 4. lukt dat niet, maak dan een ticket aan met de schermafbeelding en vermeld dat lokaal bedrijf niet is gestoord.",
      es: "1. Revise los indicadores del router y del módem de fibra in situ para confirmar que la conexión de banda ancha está activa; 2. acceda a la página de puesta en marcha y compruebe el estado de la SIM y la intensidad de señal; 3. reinicie el módulo de comunicación, espere cinco minutos y compruebe si vuelve a estar en línea; 4. si no vuelve, abra un ticket con la captura e indique que el funcionamiento local no se ve afectado.",
    },
  },
  {
    key: "combustible-gas-alarm",
    prefix: "W",
    severity: "fatal",
    base: 50,
    lines: ["residential", "cni"],
    value: { min: 6, max: 30, step: 1, decimals: 0 },
    dur: { min: 1, max: 1, step: 1 },
    desc: {
      zh: "电池仓可燃气体浓度超限。设备 {model} 的复合探测器测得可燃气体浓度为 {v} %LEL，高于 10 %LEL 的报警阈值，系统立即切断充放电、启动排风并上报该故障码。电芯热失控初期、电解液泄漏或探测器标定漂移都可能造成这一现象。本次发生于{ctx}。",
      en: "Combustible gas concentration in the battery compartment above the limit. The combined detector of unit {model} measured {v} %LEL, above the 10 %LEL alarm threshold, so the unit immediately cut charging and discharging, started ventilation and reported this fault code. Early cell thermal runaway, electrolyte leakage or detector calibration drift can all cause this. This occurred during {ctx}.",
      de: "Brenngaskonzentration im Batteriefach über dem Grenzwert. Der Kombimelder des Geräts {model} hat {v} %UEG gemessen — über der Alarmschwelle von 10 %UEG — woraufhin das Gerät Laden und Entladen sofort trennte, die Belüftung startete und diesen Fehlercode meldete. Frühe thermische Durchgänge einer Zelle, Elektrolytaustritt oder eine driftende Melderkalibrierung können das verursachen. Aufgetreten ist dies während {ctx}.",
      nl: "Concentratie brandbaar gas in het batterijvak boven de grens. De combimelder van toestel {model} mat {v} %OEG — boven de alarmdrempel van 10 %OEG — waarop het toestel laden en ontladen direct afschakelde, de ventilatie startte en deze foutcode meldde. Vroege thermische runaway van een cel, elektrolytlekkage of een verlopen kalibratie van de melder kunnen dit veroorzaken. Dit trad op tijdens {ctx}.",
      es: "Concentración de gas combustible en el compartimento de baterías por encima del límite. El detector combinado del equipo {model} midió {v} %LEL —por encima del umbral de alarma de 10 %LEL—, por lo que el equipo cortó de inmediato la carga y la descarga, activó la ventilación y registró este código. Un inicio de fuga térmica de una celda, una fuga de electrolito o una deriva de calibración del detector pueden provocarlo. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 立即疏散现场人员，禁止开关电器与插拔线缆；2. 确认排风已启动，用便携式探测器复测浓度；3. 浓度持续上升或闻到刺鼻气味时撤离并拨打消防电话，同时通知沃泰值班工程师；4. 浓度回落到 5 %LEL 以下后不要立刻复电，等工程师到场确认电芯状态。",
      en: "1. Evacuate the site immediately and do not operate switches or unplug cables; 2. confirm that ventilation has started and re-measure the concentration with a portable detector; 3. if the reading keeps rising or there is a pungent smell, withdraw, call the fire service and notify the Wotai duty engineer; 4. once the reading falls below 5 %LEL do not re-energise at once — wait until the engineer has checked the cell condition on site.",
      de: "1. Den Standort sofort räumen, keine Schalter betätigen und keine Kabel trennen; 2. bestätigen, dass die Belüftung läuft, und die Konzentration mit einem Handmessgerät nachmessen; 3. steigt der Wert weiter oder ist ein stechender Geruch wahrnehmbar, den Bereich verlassen, die Feuerwehr rufen und den Bereitschaftsingenieur von Wotai informieren; 4. sinkt der Wert unter 5 %UEG, nicht sofort wieder einschalten, sondern den Ingenieur den Zellzustand vor Ort prüfen lassen.",
      nl: "1. Ontruim het terrein direct en bedien geen schakelaars of trek geen kabels los; 2. bevestig dat de ventilatie loopt en meet de concentratie opnieuw met een draagbare melder; 3. stijgt de waarde verder of ruikt het scherp, verlaat de ruimte, bel de brandweer en waarschuw de dienstdoende engineer van Wotai; 4. zakt de waarde onder 5 %OEG, schakel dan niet direct weer in, maar laat de engineer de cellen ter plaatse beoordelen.",
      es: "1. Evacúe el emplazamiento de inmediato y no accione interruptores ni desconecte cables; 2. confirme que la ventilación se ha activado y vuelva a medir la concentración con un detector portátil; 3. si la lectura sigue subiendo o hay olor penetrante, salga, llame a los bomberos y avise al ingeniero de guardia de Wotai; 4. cuando la lectura baje de 5 %LEL no realimente de inmediato: espere a que el ingeniero compruebe el estado de las celdas in situ.",
    },
  },
  {
    key: "offgrid-overload",
    prefix: "L",
    severity: "warn",
    base: 40,
    lines: ["balcony", "residential", "cni"],
    value: { min: 105, max: 160, step: 1, decimals: 0 },
    dur: { min: 1, max: 20, step: 1 },
    desc: {
      zh: "离网输出过载。设备 {model} 检测到离网输出功率达到额定值的 {v}%，超过 100% 的过载阈值并持续 {dur} 分钟，系统限制输出并上报该故障码。启动电流大的水泵、电焊机或多台空调同时启动都会导致这一现象。本次发生于{ctx}。",
      en: "Off-grid output overload. The unit {model} measured an off-grid output of {v}% of rated power, above the 100% overload threshold for {dur} min, so output was limited and this fault code reported. A pump with a high inrush current, a welder or several air conditioners starting at once can all cause this. This occurred during {ctx}.",
      de: "Überlast am Inselnetzausgang. Das Gerät {model} hat eine Ausgangsleistung von {v} % der Nennleistung gemessen — über der Überlastschwelle von 100 % und dies für {dur} min — woraufhin die Ausgangsleistung begrenzt und dieser Fehlercode gemeldet wurde. Eine Pumpe mit hohem Anlaufstrom, ein Schweißgerät oder mehrere gleichzeitig anlaufende Klimageräte können das verursachen. Aufgetreten ist dies während {ctx}.",
      nl: "Overbelasting van de off-grid uitgang. Toestel {model} mat een uitgangsvermogen van {v}% van het nominale vermogen — boven de overbelastingsdrempel van 100 %, gedurende {dur} min — waarop het uitgangsvermogen werd begrensd en deze foutcode werd gemeld. Een pomp met hoge aanloopstroom, een lasapparaat of meerdere airco's die samen starten kunnen dit veroorzaken. Dit trad op tijdens {ctx}.",
      es: "Sobrecarga de la salida aislada. El equipo {model} midió una potencia de salida del {v} % de la nominal —por encima del umbral de sobrecarga del 100 % y durante {dur} min—, limitó la salida y registró este código. Una bomba con alta corriente de arranque, una soldadora o varios aires acondicionados arrancando a la vez pueden provocarlo. Esto ocurrió durante {ctx}.",
    },
    act: {
      zh: "1. 统计同一时段启动了哪些负载，逐个断开找出过载来源；2. 水泵、压缩机等感性负载改为分批启动，避免同时冲击；3. 长期超载时向业主说明需要增配电池或降低同时用电；4. 复位后观察带载情况，仍报同一故障码时提交工单并附负载清单。",
      en: "1. List what was started in that window and disconnect the loads one by one to find the source; 2. stagger the start of inductive loads such as pumps and compressors instead of switching them together; 3. if the overload is chronic, tell the owner that more battery capacity or a lower simultaneous demand is needed; 4. reset and watch the load, and raise a ticket with the load list if the same code returns.",
      de: "1. Erfassen, welche Lasten in diesem Zeitfenster gestartet wurden, und sie einzeln trennen, um die Ursache zu finden; 2. induktive Lasten wie Pumpen und Verdichter gestaffelt starten statt gemeinsam; 3. bei dauerhafter Überlast dem Betreiber mitteilen, dass mehr Batteriekapazität oder eine geringere Gleichzeitigkeit nötig ist; 4. zurücksetzen, die Last beobachten und bei erneutem Auftreten ein Ticket mit der Lastliste anlegen.",
      nl: "1. Inventariseer welke lasten in dat venster zijn gestart en schakel ze een voor een af om de bron te vinden; 2. start inductieve lasten zoals pompen en compressoren gespreid in plaats van tegelijk; 3. is de overbelasting structureel, leg dan uit dat meer batterijcapaciteit of minder gelijktijdig verbruik nodig is; 4. reset, bekijk de belasting en maak een ticket aan met de lastenlijst als de code terugkomt.",
      es: "1. Anote qué cargas se pusieron en marcha en esa franja y desconéctelas una a una para localizar el origen; 2. escalone el arranque de cargas inductivas como bombas y compresores en lugar de conectarlas a la vez; 3. si la sobrecarga es crónica, indique al propietario que hace falta más capacidad de batería o menos demanda simultánea; 4. reinicie, observe la carga y abra un ticket con la lista de cargas si el código reaparece.",
    },
  },
];

/* ────────────────────────── 生成 ────────────────────────── */

interface FaultRow {
  code: string;
  product_line: ProductLine;
  severity: Severity;
  desc_zh: string;
  desc_en: string;
  desc_de: string;
  desc_nl: string;
  desc_es: string;
  act_zh: string;
  act_en: string;
  act_de: string;
  act_nl: string;
  act_es: string;
}

/** mulberry32：小而稳的可复现 PRNG，同一 seed 永远同一序列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("候选集为空");
  return item;
}

function sampleSpan(rand: () => number, span: Span): number {
  const steps = Math.max(1, Math.round((span.max - span.min) / span.step));
  return span.min + Math.round(rand() * steps) * span.step;
}

function render(template: string, slots: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => slots[name] ?? whole);
}

/**
 * 实测值的小数分隔符跟着语言走：zh/en 用点，de/nl/es 用逗号 ——
 * 德语正文里阈值写的是 "3,65 V"，实测值却是 "3.72 V"，一眼就是模板没本地化。
 */
function localizeNumber(text: string, lang: Lang): string {
  return lang === "zh" || lang === "en" ? text : text.replace(".", ",");
}

/** 把基准条数按 `total` 等比缩放，余数补到第一条，保证总数分毫不差。 */
function scaleCounts(total: number): number[] {
  const baseSum = CATEGORIES.reduce((sum, category) => sum + category.base, 0);
  const counts = CATEGORIES.map((category) => Math.round((category.base * total) / baseSum));
  const drift = total - counts.reduce((sum, count) => sum + count, 0);
  counts[0] = (counts[0] ?? 0) + drift;
  return counts;
}

/** 产品线按当前负载挑最少的那条（同负载时用 PRNG 破平），让三个产线分布接近均匀。 */
function pickLine(rand: () => number, lines: readonly ProductLine[], load: Record<ProductLine, number>): ProductLine {
  const min = Math.min(...lines.map((line) => load[line]));
  return pick(
    rand,
    lines.filter((line) => load[line] === min),
  );
}

function buildRows(total: number, seed: number): FaultRow[] {
  const rand = mulberry32(seed);
  const counts = scaleCounts(total);
  const load: Record<ProductLine, number> = { balcony: 0, residential: 0, cni: 0 };
  const rows: FaultRow[] = [];

  CATEGORIES.forEach((category, index) => {
    let serial = CODE_START[category.prefix] ?? 100;
    for (let n = 0; n < (counts[index] ?? 0); n += 1) {
      const line = pickLine(rand, category.lines, load);
      load[line] += 1;
      const context = pick(rand, CONTEXTS);
      const model = pick(rand, MODELS[line]);
      const value =
        (sampleSpan(rand, category.value) / 10 ** category.value.decimals).toFixed(category.value.decimals);
      const dur = String(sampleSpan(rand, category.dur));
      const row = {
        code: `${category.prefix}${serial}`,
        product_line: line,
        severity: category.severity,
      } as FaultRow;
      serial += 1;
      for (const lang of LANGS) {
        const langSlots = { model, v: localizeNumber(value, lang), dur, ctx: context[lang] };
        row[`desc_${lang}`] = render(category.desc[lang], langSlots);
        row[`act_${lang}`] = render(category.act[lang], langSlots);
      }
      rows.push(row);
    }
  });

  return rows;
}

/* ────────────────────────── 写库 ────────────────────────── */

const INSERT_SQL = `
insert into fault_codes
  (code, product_line, severity,
   desc_zh, desc_en, desc_de, desc_nl, desc_es,
   act_zh, act_en, act_de, act_nl, act_es,
   status)
select code, product_line, severity,
       desc_zh, desc_en, desc_de, desc_nl, desc_es,
       act_zh, act_en, act_de, act_nl, act_es,
       $2
  from jsonb_to_recordset($1::jsonb) as x(
    code text, product_line text, severity text,
    desc_zh text, desc_en text, desc_de text, desc_nl text, desc_es text,
    act_zh text, act_en text, act_de text, act_nl text, act_es text)
on conflict (code, product_line) do nothing
`;

/** 100 行一条语句：`jsonb_to_recordset` 一个参数到底，不撞 3 秒的 statement_timeout。 */
const CHUNK = 100;

async function insertRows(rows: readonly FaultRow[], status: FaultStatus): Promise<number> {
  return tx(async (client) => {
    let inserted = 0;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const result = await client.query(INSERT_SQL, [JSON.stringify(chunk), status]);
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  });
}

/* ────────────────────────── CLI ────────────────────────── */

interface Options {
  count: number;
  status: FaultStatus;
  seed: number;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { count: 1000, status: "published", seed: 20261028, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} 缺参数值`);
      i += 1;
      return value;
    };
    if (arg === "--count") {
      const count = Number(next());
      if (!Number.isInteger(count) || count < 1 || count > 20_000) fail("--count 必须是 1..20000 的整数");
      options.count = count;
    } else if (arg === "--status") {
      const status = next();
      if (status !== "published" && status !== "draft") fail("--status 只接受 published 或 draft");
      options.status = status;
    } else if (arg === "--seed") {
      const seed = Number(next());
      if (!Number.isInteger(seed)) fail("--seed 必须是整数");
      options.seed = seed;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "用法：node --env-file-if-exists=.env scripts/seed-faults-bulk.ts " +
          "[--count 1000] [--status published|draft] [--seed 20261028] [--dry-run]\n",
      );
      process.exit(0);
    } else {
      fail(`不认识的参数：${arg}`);
    }
  }
  return options;
}

function log(message: string): void {
  process.stdout.write(`[seed-faults] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[seed-faults] ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = buildRows(options.count, options.seed);

  // 生成阶段就守住门禁的三条底线：码不重复、码能被公开接口查到、五语十列没有一个空串
  const codes = new Set(rows.map((row) => row.code));
  if (codes.size !== rows.length) fail(`生成的故障码有重复（${rows.length} 行只有 ${codes.size} 个不同的码）`);
  for (const row of rows) {
    if (!FAULT_CODE_RE.test(row.code)) {
      fail(`${row.code} 不符合 FAULT_CODE_RE（字母 + 2~3 位数字）：这样的码 /api/fault 查不到，插进去就是假发布`);
    }
    for (const lang of LANGS) {
      const desc = row[`desc_${lang}`];
      const act = row[`act_${lang}`];
      if (desc === undefined || desc.trim() === "" || act === undefined || act.trim() === "") {
        fail(`${row.code} 的 ${lang} 文案为空`);
      }
      if (lang !== "zh" && /[\u4e00-\u9fa5]/.test(`${desc}${act}`)) {
        fail(`${row.code} 的 ${lang} 文案混入了汉字（语种纯度门禁会红）`);
      }
    }
  }

  const bySeverity = new Map<Severity, number>();
  const byLine = new Map<ProductLine, number>();
  for (const row of rows) {
    bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + 1);
    byLine.set(row.product_line, (byLine.get(row.product_line) ?? 0) + 1);
  }
  log(
    `生成 ${rows.length} 条（status=${options.status}, seed=${options.seed}）：` +
      [...bySeverity].map(([severity, n]) => `${severity}=${n}`).join(" ") +
      " ／ " +
      [...byLine].map(([line, n]) => `${line}=${n}`).join(" "),
  );
  log(`码段 ${rows[0]?.code} … ${rows[rows.length - 1]?.code}`);

  if (options.dryRun) {
    const sample = rows[1] ?? rows[0];
    if (sample !== undefined) {
      log("样例（--dry-run 不写库）：");
      process.stdout.write(`${JSON.stringify(sample, null, 2)}\n`);
    }
    return;
  }

  const inserted = await insertRows(rows, options.status);
  const skipped = rows.length - inserted;
  log(`写入完成：新增 ${inserted} 行，已存在跳过 ${skipped} 行`);

  const [stat] = await query<{ total: number; published: number; draft: number; complete: number; with_cjk: number }>(
    `select count(*)::int as total,
            count(*) filter (where status = 'published')::int as published,
            count(*) filter (where status = 'draft')::int as draft,
            count(*) filter (where desc_zh <> '' and desc_en <> '' and desc_de <> '' and desc_nl <> ''
                               and desc_es <> '' and act_zh <> '' and act_en <> '' and act_de <> ''
                               and act_nl <> '' and act_es <> '')::int as complete,
            count(*) filter (where concat_ws(' ', desc_de, desc_nl, desc_es, act_de, act_nl, act_es) ~ '[一-龥]')::int as with_cjk
       from fault_codes`,
  );
  if (stat === undefined) fail("汇总查询没有返回行（数据库状态异常）");
  log(
    `库内现状：fault_codes 共 ${stat.total} 行（published=${stat.published} draft=${stat.draft}），` +
      `五语齐全 ${stat.complete}，de/nl/es 含汉字 ${stat.with_cjk}`,
  );
  log("下一步：/console → 故障卡面板；或 GET /api/fault/<code>?product_line=<line>");
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  fail(`执行失败：${message}`);
} finally {
  await pool.end().catch(() => undefined);
}
