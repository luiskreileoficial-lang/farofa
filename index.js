
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import qrcode from "qrcode-terminal";

const cfg = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const DB = "./database.json";

const db = (() => {
  try {
    return JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    return { users: {}, groups: {}, quizzes: {} };
  }
})();

function save() {
  fs.writeFileSync(DB, JSON.stringify(db, null, 2));
}

function baseJid(j = "") {
  return String(j).replace(/:\d+(?=@)/, "");
}

function group(j) {
  if (!db.groups[j]) {
    db.groups[j] = {
      welcomed: {},
      votes: null,
      event: null,
      caseFile: null,
      customCommands: {}
    };
  }
  return db.groups[j];
}

function user(j, n = "Pessoa") {
  j = baseJid(j);

  if (!db.users[j]) {
    db.users[j] = {
      name: n,
      points: 0,
      messages: 0,
      memory: [],
      mode: "normal",
      nickname: ""
    };
  }

  return db.users[j];
}

function textOf(m) {
  const x = m?.message || m || {};

  return (
    x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    x.ephemeralMessage?.message?.conversation ||
    x.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ""
  ).trim();
}

function quotedInfo(m) {
  const x = m?.message || {};

  return (
    x.extendedTextMessage?.contextInfo ||
    x.imageMessage?.contextInfo ||
    x.videoMessage?.contextInfo ||
    null
  );
}

function promptFor(u) {
  const modes = {
    normal:
      "Você é Farofa, assistente útil e divertida. Responda em português brasileiro.",
    paranormal:
      "Você é Farofa em clima sombrio de Ordem Paranormal, mas útil e clara. Responda em português brasileiro.",
    seria:
      "Responda de forma séria, direta e respeitosa em português brasileiro.",
    zueira:
      "Seja divertida e levemente debochada, sem crueldade. Responda em português brasileiro."
  };

  return modes[u.mode] || modes.normal;
}

async function ai(u, question, context = "") {
  const key = String(cfg.OPENROUTER_API_KEY || "").trim();

  if (!key || key === "COLE_SUA_CHAVE_AQUI") {
    return "⚠️ Configure a chave do OpenRouter no config.json.";
  }

  const messages = [
    { role: "system", content: promptFor(u) },
    ...(u.memory || []).slice(-10),
    ...(context
      ? [{ role: "user", content: "Mensagem citada: " + context }]
      : []),
    { role: "user", content: question }
  ];

  let r;

  try {
    r = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://chatgpt.com",
          "X-Title": "Farofa WhatsApp Bot"
        },
        body: JSON.stringify({
          model: cfg.OPENROUTER_MODEL || "openrouter/free",
          messages,
          temperature: 0.8,
          max_tokens: 700
        })
      }
    );
  } catch (e) {
    console.error("OpenRouter rede:", e.message);
    return "⚠️ Não consegui acessar a IA agora.";
  }

  const d = await r.json().catch(() => ({}));

  if (!r.ok) {
    console.error(
      "OpenRouter HTTP",
      r.status,
      JSON.stringify(d).slice(0, 800)
    );

    if (r.status === 401) {
      return "⚠️ Chave OpenRouter inválida.";
    }

    if (r.status === 402) {
      return "⚠️ Cota ou créditos do OpenRouter insuficientes.";
    }

    if (r.status === 429) {
      return "⚠️ Limite de requisições atingido. Aguarde e tente novamente.";
    }

    return `⚠️ Erro da IA (HTTP ${r.status}). Veja os logs.`;
  }

  const answer = d.choices?.[0]?.message?.content;

  if (typeof answer !== "string" || !answer.trim()) {
    return "⚠️ A IA não retornou texto. Confira o modelo configurado.";
  }

  u.memory ||= [];

  u.memory.push(
    { role: "user", content: question.slice(0, 1800) },
    { role: "assistant", content: answer.slice(0, 3500) }
  );

  u.memory = u.memory.slice(-20);
  save();

  return answer.slice(0, 4000);
}

async function admin(sock, chat, sender) {
  if (!chat.endsWith("@g.us")) return false;

  try {
    const m = await sock.groupMetadata(chat);
    const p = m.participants.find(
      x => baseJid(x.id) === baseJid(sender)
    );

    return p?.admin === "admin" || p?.admin === "superadmin";
  } catch {
    return false;
  }
}

function owner(j) {
  return !!cfg.OWNER_JID &&
    baseJid(j) === baseJid(cfg.OWNER_JID);
}

// Caracteres que também ativam a Farofa, conforme solicitado.
const TRIGGER_CHARS = new Set("0123456789@#$ _&-+()/*\"':;!?~`|•√π÷×§∆\\}{=°^¥€¢£%©®™✓[]".replaceAll(" ", ""));

const questions = [
  {
    q: "Qual elemento de Ordem Paranormal está ligado ao tempo?",
    a: ["morte"]
  },
  {
    q: "Qual é o protagonista de Mushoku Tensei?",
    a: ["rudeus", "rudeus greyrat"]
  },
  {
    q: "Qual planeta é conhecido como planeta vermelho?",
    a: ["marte"]
  },
  {
    q: "Quanto é 7 x 8?",
    a: ["56"]
  }
];

async function handle(sock, m) {
  if (!m.message || m.key.fromMe) return;

  const chat = m.key.remoteJid;

  if (!chat || chat === "status@broadcast") return;

  const sender = m.key.participant || chat;
  const body = textOf(m.message);

  if (!body) return;

  const u = user(sender, m.pushName);
  const g = group(chat);

  u.messages++;
  u.points++;
  save();

  const t = body.toLowerCase().trim();

  // A verificação de administrador só ocorre
  // quando um comando realmente precisa dela.
  const checkAdmin = async () =>
    owner(sender) || await admin(sock, chat, sender);

  if (t === "!menu" || t === "!ajuda") {
    return sock.sendMessage(chat, {
      text:
`🖤 *FAROFA | MENU*

!menu
!modo normal|paranormal|seria|zueira
!apelido nome
!memoria
!esquecer
!quiz
!rank
!evento texto (admin)
!votacao pergunta | opção 1 | opção 2 (admin)
!votar número
!resultado
!caso título | descrição (admin)
!caso
!criarcomando nome | resposta (admin)
!backup (admin/dono)

A IA responde quando você menciona ${cfg.BOT_NAME || "Farofa"}, responde à mensagem dela ou escreve o nome Farofa.`
    }, { quoted: m });
  }

  if (t.startsWith("!modo ")) {
    const mode = t.slice(6).trim();

    if (!["normal", "paranormal", "seria", "zueira"].includes(mode)) {
      return sock.sendMessage(chat, {
        text: "Modos: normal, paranormal, seria ou zueira."
      }, { quoted: m });
    }

    u.mode = mode;
    save();

    return sock.sendMessage(chat, {
      text: "🖤 Modo alterado: " + mode
    }, { quoted: m });
  }

  if (t.startsWith("!apelido ")) {
    u.nickname = body.slice(9).trim().slice(0, 40);
    save();

    return sock.sendMessage(chat, {
      text: "Apelido definido: " + u.nickname
    }, { quoted: m });
  }

  if (t === "!memoria") {
    return sock.sendMessage(chat, {
      text: `Memória: ${Math.floor((u.memory || []).length / 2)} trocas recentes.`
    }, { quoted: m });
  }

  if (t === "!esquecer") {
    u.memory = [];
    save();

    return sock.sendMessage(chat, {
      text: "🧹 Sua memória foi apagada."
    }, { quoted: m });
  }

  if (t === "!quiz") {
    const q = questions[Math.floor(Math.random() * questions.length)];

    db.quizzes[chat] = {
      q,
      who: baseJid(sender),
      until: Date.now() + 120000
    };

    save();

    return sock.sendMessage(chat, {
      text: "🧠 *QUIZ FAROFA*\n" + q.q +
        "\nVocê tem 2 minutos para responder."
    }, { quoted: m });
  }

  const quiz = db.quizzes[chat];

  if (
    quiz &&
    quiz.until > Date.now() &&
    quiz.who === baseJid(sender) &&
    !t.startsWith("!") &&
    quiz.q.a.includes(t.replace(/[.!?]+$/g, ""))
  ) {
    u.points += 10;
    delete db.quizzes[chat];
    save();

    return sock.sendMessage(chat, {
      text: `✅ Acertou! +10 pontos. Total: ${u.points}.`
    }, { quoted: m });
  }

  if (t === "!rank") {
    const a = Object.entries(db.users)
      .sort((x, y) => (y[1].points || 0) - (x[1].points || 0))
      .slice(0, 10)
      .map(([j, x], i) =>
        `${i + 1}. ${x.nickname || x.name || j}: ${x.points || 0} pts`
      );

    return sock.sendMessage(chat, {
      text: "🏆 *RANKING FAROFA*\n" +
        (a.join("\n") || "Sem pontuação ainda.")
    }, { quoted: m });
  }

  if (t.startsWith("!evento ")) {
    if (!(await checkAdmin())) {
      return sock.sendMessage(chat, {
        text: "Só admin/dono pode criar eventos."
      }, { quoted: m });
    }

    g.event = body.slice(8);
    save();

    return sock.sendMessage(chat, {
      text: "📅 Evento criado:\n" + g.event
    }, { quoted: m });
  }

  if (t.startsWith("!votacao ")) {
    if (!(await checkAdmin())) {
      return sock.sendMessage(chat, {
        text: "Só admin/dono pode abrir votações."
      }, { quoted: m });
    }

    const p = body.slice(9).split("|").map(x => x.trim()).filter(Boolean);

    if (p.length < 3) {
      return sock.sendMessage(chat, {
        text: "Use: !votacao pergunta | opção 1 | opção 2"
      }, { quoted: m });
    }

    g.votes = {
      q: p[0],
      options: p.slice(1, 7),
      ballots: {}
    };

    save();

    return sock.sendMessage(chat, {
      text: `🗳️ *${g.votes.q}*\n${
        g.votes.options.map((x, i) => `${i + 1}. ${x}`).join("\n")
      }\nVote com !votar número.`
    }, { quoted: m });
  }

  if (t.startsWith("!votar ")) {
    if (!g.votes) {
      return sock.sendMessage(chat, {
        text: "Não há votação aberta."
      }, { quoted: m });
    }

    const n = Number(t.slice(7));

    if (!Number.isInteger(n) || n < 1 || n > g.votes.options.length) {
      return sock.sendMessage(chat, {
        text: "Opção inválida."
      }, { quoted: m });
    }

    g.votes.ballots[baseJid(sender)] = n;
    save();

    return sock.sendMessage(chat, {
      text: "🗳️ Voto registrado."
    }, { quoted: m });
  }

  if (t === "!resultado") {
    if (!g.votes) {
      return sock.sendMessage(chat, {
        text: "Não há votação aberta."
      }, { quoted: m });
    }

    return sock.sendMessage(chat, {
      text: `📊 *${g.votes.q}*\n${
        g.votes.options.map((x, i) =>
          `${i + 1}. ${x}: ${
            Object.values(g.votes.ballots).filter(v => v === i + 1).length
          } voto(s)`
        ).join("\n")
      }`
    }, { quoted: m });
  }

  if (t.startsWith("!caso ")) {
    if (!(await checkAdmin())) {
      return sock.sendMessage(chat, {
        text: "Só admin/dono pode abrir investigação."
      }, { quoted: m });
    }

    const p = body.slice(6).split("|").map(x => x.trim());

    if (!p[0] || !p[1]) {
      return sock.sendMessage(chat, {
        text: "Use: !caso título | descrição"
      }, { quoted: m });
    }

    g.caseFile = {
      title: p[0],
      description: p[1]
    };

    save();

    return sock.sendMessage(chat, {
      text: `🕯️ *${p[0]}*\n${p[1]}`
    }, { quoted: m });
  }

  if (t === "!caso") {
    return sock.sendMessage(chat, {
      text: g.caseFile
        ? `🕯️ *${g.caseFile.title}*\n${g.caseFile.description}`
        : "Nenhuma investigação aberta."
    }, { quoted: m });
  }

  if (t.startsWith("!criarcomando ")) {
    if (!(await checkAdmin())) {
      return sock.sendMessage(chat, {
        text: "Só admin/dono pode criar comandos."
      }, { quoted: m });
    }

    const p = body.slice(14).split("|").map(x => x.trim());

    if (p.length < 2 || !/^[a-z0-9_-]{1,30}$/i.test(p[0])) {
      return sock.sendMessage(chat, {
        text: "Use: !criarcomando nome | resposta"
      }, { quoted: m });
    }

    g.customCommands[p[0].toLowerCase()] =
      p.slice(1).join(" | ").slice(0, 2500);

    save();

    return sock.sendMessage(chat, {
      text: `Comando !${p[0]} criado.`
    }, { quoted: m });
  }

  const custom = g.customCommands?.[t.replace(/^!/, "")];

  if (custom) {
    return sock.sendMessage(chat, {
      text: custom
    }, { quoted: m });
  }

  if (t === "!backup") {
    if (!(await checkAdmin())) {
      return sock.sendMessage(chat, {
        text: "Só admin do grupo ou dono pode pedir backup."
      }, { quoted: m });
    }

    return sock.sendMessage(chat, {
      document: Buffer.from(JSON.stringify(db, null, 2)),
      mimetype: "application/json",
      fileName: "farofa-backup.json",
      caption: "Backup privado da Farofa. Pode conter dados de conversa."
    });
  }

  const ctx = quotedInfo(m);
  const botJid = sock.user?.id || "";

  const mentioned = (ctx?.mentionedJid || [])
    .some(x => baseJid(x) === baseJid(botJid));

  const reply = ctx?.participant &&
    baseJid(ctx.participant) === baseJid(botJid);

  const name = String(cfg.BOT_NAME || "Farofa").toLowerCase();
  const calls = mentioned || reply || t.includes(name) || [...body].some(ch => TRIGGER_CHARS.has(ch));

  if (
    cfg.AI_ENABLED !== false &&
    (cfg.AI_ONLY_WHEN_MENTIONED_OR_REPLIED === false || calls)
  ) {
    const quoted = ctx?.quotedMessage
      ? textOf(ctx.quotedMessage)
      : "";

    const question = body.replace(
      new RegExp(
        String(cfg.BOT_NAME || "Farofa").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "ig"
      ),
      ""
    ).trim() || body;

    const answer = await ai(u, question, quoted);

    return sock.sendMessage(chat, {
      text: answer
    }, { quoted: m });
  }
}

let restarting = false;
let stopping = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  let version;

  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch {}

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Farofa", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({
    connection,
    lastDisconnect,
    qr
  }) => {
    if (qr) {
      console.log("Escaneie o QR Code:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      restarting = false;
      console.log("🖤 Farofa conectada ao WhatsApp!");
    }

    if (connection === "close" && !stopping && !restarting) {
      const code = lastDisconnect?.error?.output?.statusCode;

      console.error("Conexão fechada:", code ?? "desconhecido");

      if (code === DisconnectReason.loggedOut) {
        console.error(
          "Sessão saiu. Confira o pareamento; não apague auth automaticamente."
        );
        return;
      }

      restarting = true;

      setTimeout(() => {
        restarting = false;
        start().catch(console.error);
      }, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const m of messages) {
      try {
        await handle(sock, m);
      } catch (e) {
        console.error("Erro processando mensagem:", e?.stack || e);
      }
    }
  });
}

process.on("SIGINT", () => {
  stopping = true;
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopping = true;
  process.exit(0);
});

process.on("unhandledRejection", e =>
  console.error("Promise rejeitada:", e)
);

start().catch(e => {
  console.error("Falha ao iniciar:", e?.stack || e);
  process.exit(1);
});
