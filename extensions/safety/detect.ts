/**
 * Safety Detection — 纯逻辑层（零 Pi 依赖）
 *
 * - Command Guard:   危险命令检测 + 覆盖写入检测 + 读取保护路径检测
 * - Secret Detection: 40+ 高置信模式 + 熵分析 V3+Dict + 安全模式排除
 *
 * 本模块可独立测试，不依赖 Pi API。
 */

import * as fs from "node:fs";
import { resolve } from "node:path";

const DANGEROUS_COMMANDS: [string, string[]][] = [
  ["rm", []],
  ["sudo", []],
  ["npm", ["publish"]],
  ["svn", ["commit", "revert"]],
  ["git", ["reset", "restore", "clean", "push", "revert"]],
];

const SAFE_REDIRECT_TARGETS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
]);

const SHELL_SEGMENT_BREAKS = new Set(["|", "&&", "||", ";"]);
const SHELL_REDIRECT_OVERWRITE = new Set([">", "1>", "2>", "&>"]);

// ─── 保护路径 ────────────────────────────────────────────────────────────────

const PROTECTED_PATH_SEGMENTS = [
  ".env", ".git/", ".ssh/",
  ".gnupg/", ".aws/", "secrets/", ".docker/",
];
const PROTECTED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore"];
const PROTECTED_FILENAMES = [
  "id_rsa", "id_ed25519", "id_ecdsa",
  "authorized_keys", "known_hosts",
  ".env.local", ".env.production",
];

/** Commands that read file contents (should confirm before reading protected paths) */
const READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "batcat",
  "tac", "nl", "od", "xxd", "hexdump", "base64",
  "file", "strings", "grep", "rg", "ag", "ack",
]);

export function checkProtectedPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? "";
  for (const seg of PROTECTED_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return `path contains "${seg}"`;
  }
  for (const ext of PROTECTED_EXTENSIONS) {
    if (normalized.endsWith(ext)) return `file extension "${ext}"`;
  }
  for (const name of PROTECTED_FILENAMES) {
    if (filename === name) return `protected file "${name}"`;
  }
  return null;
}

// ─── Shell tokenizer ────────────────────────────────────────────────────────

export function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[i + 1]!;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (ch === ";") {
      pushCurrent();
      tokens.push(";");
      continue;
    }

    if (ch === "|" || ch === "&") {
      if (i + 1 < command.length && command[i + 1] === ch) {
        pushCurrent();
        tokens.push(ch + ch);
        i += 1;
        continue;
      }
      if (ch === "|") {
        pushCurrent();
        tokens.push("|");
        continue;
      }
    }

    if (ch === ">") {
      let op = ">";
      if (i + 1 < command.length && command[i + 1] === ">") {
        op = ">>";
        i += 1;
      }
      if (current === "&" || /^\d+$/.test(current)) {
        op = current + op;
        current = "";
      } else {
        pushCurrent();
      }
      tokens.push(op);
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return tokens;
}

function isExistingRegularFile(target: string, cwd: string): boolean {
  if (!target || SAFE_REDIRECT_TARGETS.has(target)) return false;
  try {
    return fs.statSync(resolve(cwd, target)).isFile();
  } catch {
    return false;
  }
}

// ─── Bash danger analysis ───────────────────────────────────────────────────

export interface BashDanger {
  reason: string;
  /** Whether the danger involves a protected (sensitive) path */
  protectedPath?: string;
}

export function collectBashDangers(command: string, cwd: string): BashDanger[] {
  const tokens = tokenizeShell(command);
  const dangers: BashDanger[] = [];
  const seen = new Set<string>();

  const addDanger = (reason: string, protectedPath?: string) => {
    if (seen.has(reason)) return;
    seen.add(reason);
    dangers.push({ reason, protectedPath });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (SHELL_SEGMENT_BREAKS.has(token)) continue;

    // ── Dangerous commands ──
    for (const [cmd, subs] of DANGEROUS_COMMANDS) {
      const name = token.split("/").pop() ?? token;
      if (name !== cmd && name !== `${cmd}.exe`) continue;
      if (subs.length === 0) {
        addDanger(`"${cmd}" is a dangerous command`);
        break;
      }
      const next = tokens[i + 1];
      if (next && subs.includes(next)) {
        addDanger(`"${cmd} ${next}" is a dangerous command`);
        break;
      }
    }

    // ── Overwrite redirect (>) ──
    if (SHELL_REDIRECT_OVERWRITE.has(token)) {
      const target = tokens[i + 1];
      if (target && isExistingRegularFile(target, cwd)) {
        const prot = checkProtectedPath(target);
        if (prot) {
          addDanger(
            `shell redirection would overwrite existing file "${target}"\n    Sensitive: ${prot}, may contain sensitive information`,
            prot,
          );
        } else {
          addDanger(`shell redirection would overwrite existing file "${target}"`);
        }
      }
      continue;
    }

    // ── Read commands on protected paths ──
    const cmdName = token.split("/").pop() ?? token;
    if (READ_COMMANDS.has(cmdName) || READ_COMMANDS.has(`${cmdName}.exe`)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const next = tokens[j]!;
        if (SHELL_SEGMENT_BREAKS.has(next)) break;
        if (next.startsWith("-")) continue;
        if (next.includes("/") || next.startsWith(".") || isExistingRegularFile(next, cwd)) {
          const prot = checkProtectedPath(next);
          if (prot) {
            addDanger(
              `"${cmdName}" reads protected file "${next}"\n    Sensitive: ${prot}, may contain sensitive information`,
              prot,
            );
          }
        }
      }
    }

    // ── tee writes to existing files ──
    if (cmdName === "tee" || cmdName === "tee.exe") {
      for (let j = i + 1; j < tokens.length; j++) {
        const next = tokens[j]!;
        if (SHELL_SEGMENT_BREAKS.has(next)) break;
        if (next === "-a" || next === "--append") continue;
        if (next.startsWith("-")) continue;
        if (isExistingRegularFile(next, cwd)) {
          const prot = checkProtectedPath(next);
          if (prot) {
            addDanger(
              `"tee" would write to existing file "${next}"\n    Sensitive: ${prot}, may contain sensitive information`,
              prot,
            );
          } else {
            addDanger(`"tee" would write to existing file "${next}"`);
          }
        }
      }
    }
  }

  return dangers;
}

export function formatBashDangers(dangers: BashDanger[]): string | null {
  if (dangers.length === 0) return null;
  if (dangers.length === 1) return dangers[0]!.reason;
  return `dangerous operations detected:\n- ${dangers.map(d => d.reason).join("\n- ")}`;
}

// ─── Secret Detection — Entropy + Pattern ────────────────────────────────────
//
// Based on opencode-secrets-protect by Jared Scheel
// https://github.com/jscheel/opencode-secrets-protect (MIT License)
//
// Detection pipeline:  High-confidence patterns (40+ known formats)
//                   → Low-confidence patterns (generic assignments, context-checked)
//                   → Adjusted Shannon Entropy v3+Dict (unknown formats)
//                   → Safe pattern exclusion (reduce false positives)
//
// Entropy v3+Dict formula:
//   adjusted = baseShannon + trigramDensity×W1 - wordRatio×W2 - dictRatio×W3 - hexPenalty
//
// - baseShannon: Claude E. Shannon's 1948 "A Mathematical Theory of Communication"
// - trigramDensity: 3-char sliding window scores class transitions:
//     • Letter↔Digit (digit in first 2 positions) → 1.0
//     • Contains '-' with ≥3 classes → 1.0
//     • AbA pattern (≥2 uppercase + lowercase) → 0.8
//   X-class chars (not letter/digit/dash) split segments independently
// - wordRatio: vowel-containing lowercase fragments penalize secret likelihood
// - dictRatio: dictionary word coverage penalizes identifiers/English text
// - hexPenalty: -2.5 only if >90% hex AND contains '-' (UUID-like format)

//
// Based on opencode-secrets-protect by Jared Scheel
// https://github.com/jscheel/opencode-secrets-protect (MIT License)
//
// Detection approach:
//   1. Split content by whitespace + code punctuation
//   2. For each token ≥ 16 chars, compute adjusted entropy:
//        adjusted = baseShannon + trigramDensity×W1 - wordRatio×W2 - dictRatio×W3 - hexPenalty
//   3. Trigram density uses a 3-character sliding window:
//        - AbA pattern (≥2 uppercase) → 0.8
//        - Letter↔Digit (digit in first 2 positions) → 1.0
//        - Contains '-' with ≥3 classes → 1.0
//      X-class chars split the token into independent segments;
//      the segment with the highest density is used.
//   4. wordRatio: ratio of vowel-containing lowercase fragments ≥3 chars
//   5. dictRatio: ratio of dictionary word coverage (2121 English + tech words)
//   6. hexPenalty: -2.5 only if >90% hex AND contains '-' (UUID-like format)

/** Character class: U=uppercase, L=lowercase, D=digit, S=dash, X=other */
export function charClass(c: string): "U" | "L" | "D" | "S" | "X" {
  const code = c.charCodeAt(0);
  if (code >= 65 && code <= 90) return "U";
  if (code >= 97 && code <= 122) return "L";
  if (code >= 48 && code <= 57) return "D";
  if (c === "-") return "S";
  return "X";
}

/**
 * Shannon entropy: measures average information content per character.
 * H(X) = -Σ p(x) · log₂(p(x))
 */
export function shannonEntropy(data: string): number {
  if (data.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of data) {
    freq.set(char, (freq.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  const len = data.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Trigram (3-character sliding window) scoring.
 * Rules (user-specified):
 *   - Pure digits → 0
 *   - Letter↔Digit switch (digit in first 2 positions, e.g. 4Vi, K9m, a9t) → 1.0
 *   - Contains '-' with ≥3 distinct classes → 1.0
 *   - Case switch AbA pattern (≥2 uppercase + ≥1 lowercase) → 0.8
 *   - Otherwise → 0
 */
export function trigramScore(c1: string, c2: string, c3: string): number {
  const cls: string[] = [charClass(c1), charClass(c2), charClass(c3)];

  // Any X-class character → skip
  if (cls.includes("X")) return 0;

  const unique = new Set(cls);

  // Pure digits → 0
  if (unique.size === 1 && cls[0] === "D") return 0;

  // Contains '-' (S-class) with ≥3 distinct classes → 1.0
  if (cls.includes("S") && unique.size >= 3) return 1.0;

  // Letter↔Digit: digit must be in first 2 positions
  const hasDigit = cls.includes("D");
  const hasLetter = cls.includes("L") || cls.includes("U");
  if (hasDigit && hasLetter && (cls[0] === "D" || cls[1] === "D")) return 1.0;

  // AbA pattern: ≥2 uppercase + ≥1 lowercase (e.g. KeA, but not API)
  const uCount = cls.filter(c => c === "U").length;
  const lCount = cls.filter(c => c === "L").length;
  if (uCount >= 2 && lCount >= 1) return 0.8;

  return 0;
}

/**
 * Split a token by X-class characters into independent segments.
 * This prevents `://`, `@`, `.` etc. from diluting trigram density.
 */
export function splitByXClass(token: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const c of token) {
    if (charClass(c) === "X") {
      if (current.length >= 3) segments.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.length >= 3) segments.push(current);
  return segments;
}

/**
 * Compute average trigram density for a single segment.
 */
export function segmentDensity(segment: string): number {
  if (segment.length < 3) return 0;
  let totalScore = 0;
  for (let i = 0; i <= segment.length - 3; i++) {
    totalScore += trigramScore(segment[i]!, segment[i + 1]!, segment[i + 2]!);
  }
  return totalScore / (segment.length - 2);
}

/**
 * Compute the maximum segment density across all X-split segments.
 * The segment with the highest density is the most likely secret region.
 */
export function maxSegmentDensity(token: string): number {
  const segments = splitByXClass(token);
  if (segments.length === 0) return 0;
  let maxD = 0;
  for (const seg of segments) {
    const d = segmentDensity(seg);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

/**
 * Word ratio: fraction of token that consists of vowel-containing
 * lowercase fragments ≥3 characters. Natural language words reduce
 * the likelihood of being a secret.
 */
export function computeWordRatio(token: string): number {
  // Split by class boundaries
  const segments: string[] = [];
  let current = "";
  let prevClass = "";
  for (const c of token) {
    const cls = charClass(c);
    if (cls === "X") {
      if (current.length > 0) { segments.push(current); current = ""; }
      prevClass = "";
      continue;
    }
    if (cls !== prevClass && current.length > 0) {
      segments.push(current);
      current = "";
    }
    current += c;
    prevClass = cls;
  }
  if (current.length > 0) segments.push(current);

  let wordLen = 0;
  for (const seg of segments) {
    if (seg.length >= 3 && /^[a-z]+$/.test(seg)) {
      if (/[aeiou]/.test(seg)) wordLen += seg.length;
    }
  }
  return token.length > 0 ? wordLen / token.length : 0;
}

/**
 * Hex ratio: fraction of characters that are hex characters (0-9, a-f, A-F, -).
 * Values >0.9 indicate UUIDs or hex hashes which are safe.
 */
export function computeHexRatio(token: string): number {
  let hexChars = 0;
  for (const c of token) {
    if (/[0-9a-fA-F\-]/.test(c)) hexChars++;
  }
  return token.length > 0 ? hexChars / token.length : 0;
}

// ── Dictionary Words for Secret Detection ─────────────────────────────────────
//
// Based on Google 10K most common English words (len >= 4)
// + top 500 most common words (len >= 3)
// + ~80 common tech abbreviations that appear in code identifiers.
// Used by computeDictRatio() to penalize tokens containing known words.
//
// Word list source: https://github.com/first20hours/google-10000-english (public domain)

const DICT_WORDS: ReadonlySet<string> = new Set(
  // prettier-ignore
  JSON.parse(`["ability","able","about","above","abstract","abuse","academic","accept","acceptance","accepted","access","accessories","accommodation","according","account","accounting","accounts","across","action","actions","active","activities","activity","actual","actually","added","addition","additional","address","adm","admin","administration","administrative","adult","advance","advanced","adventure","advertise","advertisement","advertising","advice","aes","affairs","affiliate","affiliates","africa","african","after","again","against","agencies","agency","agent","agents","agree","agreement","airport","album","allow","allowed","allows","almost","alone","along","already","also","alternative","although","always","amateur","amazon","america","american","among","amount","analysis","angeles","animal","animals","announcements","annual","another","answer","answers","anti","anyone","anything","apartments","api","apparel","appear","apple","application","applications","applied","apply","approach","appropriate","approval","approved","approximately","april","architecture","archive","archives","area","areas","argument","arizona","army","around","article","articles","artist","artists","arts","asia","asian","asked","assessment","assistance","assistant","associated","associates","association","attack","attention","attorney","auction","auctions","audio","august","australia","australian","auth","author","authority","authors","auto","automatically","automotive","availability","available","avenue","average","avg","avoid","award","awards","away","baby","back","background","balance","ball","band","bank","base","baseball","based","basic","basis","basket","battery","beach","beautiful","beauty","became","because","become","been","before","began","begin","beginning","behind","being","believe","below","benefit","benefits","best","better","between","beyond","bible","bill","birth","black","block","blog","blogs","blood","blue","board","boards","body","book","books","born","boston","both","bottom","boys","branch","brand","brands","break","breakfast","breast","bridge","bring","british","brought","brown","browse","browser","btn","budget","buf","build","building","built","bush","business","businesses","button","buyer","buying","cable","calendar","california","call","called","calls","came","camera","cameras","camp","campaign","campus","canada","canadian","cancer","canon","capacity","capital","card","cards","care","career","careers","carolina","cars","cart","case","cases","cash","casino","catalog","categories","category","cause","cb","cell","cells","center","centers","central","centre","century","certain","certificate","certified","cfg","chain","chair","challenge","chance","change","changed","changes","channel","chapter","character","characters","charge","charges","charles","chart","chat","cheap","check","chemical","chicago","chief","child","children","china","chinese","choice","choose","chris","christian","christmas","church","cities","city","civil","claim","claims","class","classes","classic","classifieds","clean","clear","cli","click","client","clients","clinical","close","closed","clothing","club","clubs","cnet","cnt","coast","code","codes","coffee","col","cold","collection","college","color","colorado","columbia","column","come","comes","coming","command","comment","comments","commerce","commercial","commission","committee","common","communication","communications","communities","community","companies","company","compare","compared","comparison","competition","complete","completed","complex","compliance","component","components","comprehensive","computer","computers","computing","condition","conditions","conference","configuration","congress","connect","connection","consider","considered","construction","consumer","contact","contacts","contains","content","contents","context","continue","continued","contract","control","cool","copy","copyright","core","corner","corporate","corporation","correct","cost","costs","could","council","count","counter","countries","country","county","couple","course","courses","court","cover","coverage","covered","cpu","create","created","creating","creative","credit","creek","crime","critical","cross","crud","css","csv","cultural","culture","currency","current","currently","custom","customer","customers","daily","damage","dance","dark","data","database","date","dates","dating","david","days","db","dead","deal","deals","death","debt","december","decision","deep","default","defense","define","defined","definition","degree","delivery","demand","department","described","description","design","designated","designed","desktop","detail","detailed","details","determine","determined","dev","develop","developed","developer","developing","development","device","devices","diamond","dictionary","died","diet","difference","different","difficult","digital","dir","direct","directions","directly","director","directory","disclaimer","discount","discuss","discussion","disease","disp","display","distance","distribution","district","division","dlg","dns","doctor","document","documentation","documents","does","doing","dollar","dollars","domain","domestic","done","door","double","down","download","downloads","draft","drive","driver","driving","drop","drug","drugs","dst","during","dvds","each","early","earth","easily","east","eastern","easy","ebay","economic","economy","edge","edit","edition","editor","education","educational","effect","effective","effects","effort","efforts","either","election","electric","electronic","electronics","element","elements","else","email","emergency","emit","employee","employees","employment","enable","ending","energy","engine","engineering","england","english","enjoy","enough","ensure","enter","enterprise","entertainment","entire","entries","entry","env","environment","environmental","equal","equipment","err","error","errors","especially","essential","established","estate","europe","european","evaluation","even","event","events","ever","every","everyone","everything","evidence","evt","example","examples","excellent","except","exchange","executive","exercise","existing","expect","expected","experience","expert","express","ext","extended","extension","external","extra","eyes","face","facilities","facility","fact","factor","factors","facts","faculty","failure","fair","faith","fall","families","family","fantasy","farm","fashion","fast","father","favorite","feat","feature","featured","features","february","federal","feed","feedback","feel","fees","feet","female","fiction","field","fields","figure","file","files","fill","film","films","filter","final","finally","finance","financial","find","finding","fine","fire","firm","first","fish","fishing","fitness","five","fixed","fixme","flag","flash","flat","flight","floor","florida","flow","flowers","focus","follow","following","follows","font","food","foot","football","force","ford","foreign","forest","form","format","former","forms","forum","forums","forward","found","foundation","four","frame","france","francisco","free","freedom","french","fresh","friday","friend","friendly","friends","from","front","ftr","fuel","full","fully","function","functional","functions","fund","funding","funds","furniture","further","future","galleries","gallery","game","games","gamma","garden","gave","gear","general","generally","generated","generation","george","georgia","german","germany","gets","getting","gid","gift","gifts","girl","girls","git","give","given","gives","giving","glass","global","goal","goals","goes","going","gold","golden","golf","gone","good","goods","google","government","gpt","gpu","grade","graduate","grand","grant","graphics","great","greater","green","ground","group","groups","growing","growth","grp","guarantee","guest","gui","guide","guidelines","guides","guitar","guys","hack","hair","half","hall","hand","hands","happy","hard","hardware","have","having","hdr","head","headlines","health","hear","heard","hearing","heart","heat","heavy","held","help","helpful","here","high","higher","highest","highly","hill","himself","hire","historical","history","hits","hold","holiday","holidays","home","homepage","homes","hook","hope","horse","hospital","host","hosting","hotel","hotels","hour","hours","house","housing","houston","however","html","huge","human","icon","idea","ideas","identify","idx","illinois","image","images","img","immediately","impact","implementation","important","improve","improvement","inch","include","included","includes","including","income","increase","increased","independent","index","india","indian","individual","individuals","industrial","industry","info","information","informed","initial","input","inside","install","installation","instead","institute","institutions","instructions","instruments","insurance","int","integrated","intended","interactive","interest","interested","interesting","interests","interface","internal","international","internet","into","introduction","investment","involved","ipod","iraq","ireland","isbn","island","islands","israel","issue","issues","italian","italy","item","items","itself","jack","jackson","james","january","japan","japanese","java","jersey","jesus","jewelry","jobs","john","johnson","join","joined","joint","jones","journal","json","july","jump","june","just","justice","kansas","keep","key","keyword","keywords","kids","kind","kinds","king","kingdom","kitchen","know","knowledge","known","kong","label","labor","lake","lan","land","language","languages","large","larger","largest","last","late","later","latest","latin","laws","lead","leader","leaders","leadership","leading","league","learn","learning","least","leather","leave","left","legal","len","length","lesbian","less","letter","letters","level","levels","lib","library","license","life","light","like","likely","limit","limited","line","lines","link","links","linux","list","listed","listen","listing","listings","lists","literature","little","live","lives","living","llm","load","loan","loans","local","located","location","locations","login","logo","london","long","longer","look","looking","looks","lord","loss","lost","lots","louis","love","lower","lowest","lyrics","mac","machine","machines","made","magazine","magazines","magic","mail","mailing","main","maintenance","major","make","makes","making","male","manage","management","manager","manual","manufacturer","manufacturing","many","maps","march","marine","mark","market","marketing","markets","martin","mary","mass","master","match","matching","material","materials","matter","mature","max","maximum","maybe","mean","means","measures","media","medical","medicine","medium","meet","meeting","meetings","mega","member","members","membership","memory","mental","menu","merchant","message","messages","metal","method","methods","mexico","michael","michigan","micro","microsoft","middle","might","mike","miles","military","million","min","mind","mini","minimum","minister","minnesota","minute","minutes","miss","missing","mission","mobile","mock","mod","mode","model","models","modern","modified","module","moment","monday","money","monitor","monitoring","month","monthly","months","more","morning","mortgage","most","mother","motion","motor","motorola","mount","mountain","move","moved","movement","movie","movies","moving","msg","much","multi","multimedia","multiple","museum","music","musical","must","myself","naked","name","names","nano","nation","national","native","natural","nature","nav","navigation","near","necessary","need","needed","needs","net","network","networking","networks","never","news","newsletter","next","nice","night","nlp","nokia","none","normal","north","northern","note","notes","nothing","notice","november","npm","num","number","numbers","nursing","oauth","object","october","offer","offered","offering","offers","office","officer","official","often","ohio","older","once","ones","online","only","ontario","open","opening","operating","operation","operations","opinion","opportunities","opportunity","ops","option","optional","options","oral","orange","order","orders","oregon","organization","organizations","original","orm","oss","other","others","otherwise","outdoor","output","outside","over","overall","overview","owned","owner","owners","pacific","pack","package","packages","page","pages","paid","pain","palm","panel","paper","paperback","papers","parent","parents","paris","park","parking","part","particular","particularly","parties","partner","partners","parts","party","pass","password","past","patch","path","patient","patients","paul","payment","paypal","peace","pennsylvania","people","percent","perfect","performance","perhaps","period","perm","permission","person","personal","persons","peter","phase","phentermine","phone","phones","photo","photography","photos","physical","pick","pics","picture","pictures","pid","piece","pink","pip","pipe","pkg","place","placed","places","plan","planning","plans","plant","plants","plastic","platform","play","played","player","players","playing","please","plus","pocket","point","points","poker","pol","police","policies","policy","political","politics","pool","poor","pop","popular","population","port","pos","position","positive","possible","post","posted","poster","posters","posts","potential","power","powered","practice","practices","premium","present","presentation","presented","president","press","pressure","pretty","prev","prevent","previous","price","prices","pricing","primary","prime","print","printer","printing","prior","privacy","private","pro","probably","problem","problems","procedure","procedures","process","processes","processing","prod","produce","produced","product","production","products","professional","professor","profile","profit","program","programme","programming","programs","progress","project","projects","properties","property","proposed","protect","protection","protein","provide","provided","provider","providers","provides","providing","ptr","public","publication","publications","published","publisher","publishing","purchase","purpose","purposes","quality","quantity","quarter","question","questions","quick","quickly","quite","quote","quotes","race","racing","radio","ram","random","range","rank","rate","rated","rates","rather","rating","ratings","reach","read","reader","readers","reading","ready","real","really","reason","reasons","receive","received","recent","recently","recipes","recommend","recommendations","recommended","record","records","recovery","reduce","ref","reference","references","regarding","region","regional","register","registered","registration","regular","regulations","related","relations","relationship","release","released","releases","relevant","religion","religious","remember","remote","remove","rent","rental","rentals","repair","replies","reply","report","reported","reporting","reports","republic","req","request","requests","require","required","requirements","requires","res","research","reserve","reserved","resolution","resort","resource","resources","respect","respective","response","responsibility","responsible","rest","restaurant","restaurants","result","results","retail","return","returns","rev","review","reviews","rich","richard","right","rights","ring","ringtones","risk","river","road","robert","rock","rol","role","room","rooms","root","rose","round","row","royal","rsa","rule","rules","running","russia","russian","safe","safety","said","saint","sale","sales","same","sample","samsung","santa","satellite","saturday","save","saying","says","scale","schedule","school","schools","science","sciences","scientific","score","scott","screen","sdk","search","searches","season","seattle","second","seconds","secretary","section","sections","sector","secure","security","seem","seems","seen","select","selected","selection","self","sell","seller","sellers","selling","send","senior","sense","sent","separate","september","sequence","series","serious","serve","server","servers","service","services","session","sets","setting","settings","seven","several","sha","shall","share","sheet","ship","shipping","ships","shirt","shirts","shoes","shop","shopping","shops","short","shot","should","show","showing","shown","shows","sid","side","sign","signed","significant","silver","similar","simple","simply","since","single","site","sitemap","sites","situation","size","skills","skin","skip","small","smart","smith","snow","social","society","soft","software","sold","solid","solution","solutions","some","someone","something","sometimes","song","songs","sony","soon","sorry","sort","sorted","sound","source","sources","south","southern","space","spain","spanish","special","species","specific","specified","speed","spirit","sponsored","sport","sports","spring","sql","square","src","sre","ssd","ssh","ssl","staff","stage","stand","standard","standards","star","stars","start","started","starting","state","statement","statements","states","station","statistics","status","stay","steel","step","steps","steve","still","stock","stone","stop","storage","store","stores","stories","story","str","strategies","strategy","stream","street","string","strong","structure","stub","student","students","studies","studio","study","stuff","style","subject","subjects","submit","submitted","subs","subscribe","success","successful","such","suggest","suite","sum","summary","summer","sunday","super","supplies","supply","support","supported","sure","surface","surgery","survey","switch","system","systems","tab","table","tables","tag","tags","take","taken","takes","taking","talk","talking","target","task","tcp","teacher","teachers","teaching","team","tech","technical","techniques","technologies","technology","teen","teens","telephone","television","tell","temp","temperature","term","terms","test","testing","tests","texas","text","than","thank","thanks","that","their","them","theme","themselves","then","theory","therapy","there","therefore","these","they","thing","things","think","thinking","third","this","thomas","those","though","thought","thoughts","thousands","thread","three","through","throughout","thursday","thus","tickets","tid","time","times","tip","tips","title","titles","tls","tmp","today","todo","together","told","took","tool","tools","topic","topics","total","touch","tour","tours","towards","town","toys","track","trade","trademarks","trading","traditional","traffic","training","transfer","transport","transportation","travel","treatment","tree","trial","trip","true","trust","truth","trying","tuesday","turn","type","types","udp","uid","under","understand","understanding","union","unique","unit","united","units","universal","university","unknown","unless","until","update","updated","updates","upgrade","upon","upper","urban","url","used","useful","user","username","users","uses","using","usr","usually","vacation","val","valid","valley","value","values","variable","variety","various","vegas","vehicle","vehicles","ver","version","very","video","videos","view","viewed","views","village","virginia","virtual","virus","vision","visit","visitors","visual","voice","volume","vote","vpn","wait","walk","wall","wan","want","wanted","warning","washington","waste","watch","watches","water","ways","weather","website","websites","wedding","wednesday","week","weekend","weekly","weeks","weight","welcome","well","went","were","west","western","what","when","where","whether","which","while","white","whole","wholesale","whose","wide","wife","wild","will","william","williams","wind","window","windows","wine","winter","wireless","wish","with","within","without","woman","women","wood","word","words","work","worked","workers","working","works","workshop","world","worldwide","worth","would","write","writing","written","wrong","wrote","xbox","xml","yahoo","yaml","year","years","yellow","yesterday","york","young","your","yourself","youth","zealand","zone"]`)
);

/**
 * Dictionary word ratio: fraction of token characters covered by dictionary words.
 *
 * Extracts lowercase letter sequences from the token, then greedily matches
 * the longest dictionary word at each position. Returns matched character
 * count / token length.
 *
 * "devstral-small-2" → finds "dev", "str", "small" → covers 11/16 chars
 * "aB3xK9mPqR7wN"   → no words found → dictRatio = 0
 */
export function computeDictRatio(token: string): number {
  // Extract lowercase letter sequences (>= 3 chars)
  const lowerSeqs: string[] = [];
  let current = "";
  for (const c of token) {
    if (/[a-z]/.test(c)) {
      current += c;
    } else {
      if (current.length >= 3) lowerSeqs.push(current);
      current = "";
    }
  }
  if (current.length >= 3) lowerSeqs.push(current);

  if (lowerSeqs.length === 0) return 0;

  // Greedy match: find longest word at each position, then skip past it
  let matchedChars = 0;
  for (const seq of lowerSeqs) {
    let pos = 0;
    while (pos < seq.length) {
      let longestMatch = 0;
      for (let end = seq.length; end > pos; end--) {
        if (DICT_WORDS.has(seq.slice(pos, end))) {
          longestMatch = end - pos;
          break;
        }
      }
      if (longestMatch > 0) {
        matchedChars += longestMatch;
        pos += longestMatch;
      } else {
        pos++;
      }
    }
  }

  return token.length > 0 ? matchedChars / token.length : 0;
}

// ── Entropy Constants ────────────────────────────────────────────────────────

export const ENTROPY_THRESHOLD = 5.5;
export const MIN_ENTROPY_TOKEN_LENGTH = 16;
export const W1_DENSITY = 3.0;
export const W2_WORD = 3.0;
export const W3_DICT = 4.0;
export const HEX_PENALTY = 2.5;
export const HEX_RATIO_THRESHOLD = 0.9;

/**
 * Adjusted entropy v3+Dict:
 *   adjusted = baseShannon + trigramDensity×W1 - wordRatio×W2 - dictRatio×W3 - hexPenalty
 */
export function calculateAdjustedEntropy(data: string): number {
  const base = shannonEntropy(data);
  const density = maxSegmentDensity(data);
  const wordRatio = computeWordRatio(data);
  const dictRatio = computeDictRatio(data);
  const hexRatio = computeHexRatio(data);

  const densityBoost = density * W1_DENSITY;
  const wordPenalty = wordRatio * W2_WORD;
  const dictPenalty = dictRatio * W3_DICT;
  // Hex penalty: only for hyphenated UUID-like tokens (>90% hex AND contains -)
  // Pure hex strings without hyphens might be real secrets (not UUIDs/SHAs)
  const hp = (hexRatio > HEX_RATIO_THRESHOLD && data.includes("-")) ? HEX_PENALTY : 0;
  return base + densityBoost - wordPenalty - dictPenalty - hp;
}

export function isHighEntropy(data: string): boolean {
  if (data.length < MIN_ENTROPY_TOKEN_LENGTH) return false;
  if (isSafeContent(data)) return false;
  return calculateAdjustedEntropy(data) > ENTROPY_THRESHOLD;
}

/**
 * Split by whitespace only — the most conservative tokenization.
 * This preserves JSON structure, URLs, and connection strings.
 */
export function findHighEntropyTokens(content: string): string[] {
  const tokens = content.split(/[\s\[\]{}"',\/\\|()&#@!<>?]+/);
  return tokens.filter(t => t.length >= MIN_ENTROPY_TOKEN_LENGTH && isHighEntropy(t));
}

// ── Known Secret Patterns ────────────────────────────────────────────────────

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  minLength: number;
  allowsSpaces: boolean;
  /** If true, skip safe-pattern exclusion (unambiguous prefix) */
  highConfidence: boolean;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { name: "AWS Access Key ID",         pattern: /AKIA[0-9A-Z]{16}/,                                                minLength: 16,  allowsSpaces: false, highConfidence: true },
  { name: "AWS Secret Access Key",    pattern: /(?:aws)?_?(?:secret)?_?(?:access)?_?key['"\s:=]+['"]?[0-9a-zA-Z/+]{40}['"]?/i, minLength: 30, allowsSpaces: false, highConfidence: true },
  // GitHub
  { name: "GitHub OAuth Token",       pattern: /gho_[0-9a-zA-Z]{36}/,                                            minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "GitHub App Token",          pattern: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/,                                    minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "GitHub PAT",               pattern: /ghp_[0-9a-zA-Z]{36}/,                                            minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "GitHub Fine-Grained Token", pattern: /github_pat_[0-9a-zA-Z_]{22,}/,                                   minLength: 26,  allowsSpaces: false, highConfidence: true },
  // GitLab
  { name: "GitLab PAT",              pattern: /glpat-[0-9a-zA-Z\-_]{20,}/,                                      minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "GitLab Runner Token",      pattern: /glrt-[0-9a-zA-Z_\-]{20,}/,                                      minLength: 20,  allowsSpaces: false, highConfidence: true },
  // Slack
  { name: "Slack Token",             pattern: /xox[baprs]-[0-9a-zA-Z\-]{10,48}/,                                minLength: 15,  allowsSpaces: false, highConfidence: true },
  { name: "Slack Webhook URL",        pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8,}\/B[a-zA-Z0-9_]{8,}\/[a-zA-Z0-9_]{24}/, minLength: 60, allowsSpaces: false, highConfidence: true },
  // JWT
  { name: "JSON Web Token",          pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, minLength: 36, allowsSpaces: false, highConfidence: true },
  // Google
  { name: "Google API Key",          pattern: /AIza[0-9A-Za-z\-_]{35}/,                                         minLength: 35,  allowsSpaces: false, highConfidence: true },
  { name: "Google OAuth Token",       pattern: /ya29\.[0-9A-Za-z\-_]+/,                                          minLength: 10,  allowsSpaces: false, highConfidence: true },
  // Stripe
  { name: "Stripe Secret Key",       pattern: /sk_live_[0-9a-zA-Z]{24,}/,                                       minLength: 24,  allowsSpaces: false, highConfidence: true },
  { name: "Stripe Restricted Key",    pattern: /rk_live_[0-9a-zA-Z]{24,}/,                                       minLength: 24,  allowsSpaces: false, highConfidence: true },
  // Twilio / SendGrid / Discord
  { name: "Twilio API Key",          pattern: /SK[a-z0-9]{32}/,                                                 minLength: 30,  allowsSpaces: false, highConfidence: true },
  { name: "SendGrid API Key",        pattern: /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{40,}/,                    minLength: 40,  allowsSpaces: false, highConfidence: true },
  { name: "Discord Bot Token",        pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/,                    minLength: 40,  allowsSpaces: false, highConfidence: true },
  // OpenAI / Anthropic / Volcengine Ark
  { name: "OpenAI API Key",          pattern: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ[a-zA-Z0-9]{20,}/,                    minLength: 40,  allowsSpaces: false, highConfidence: true },
  { name: "OpenAI API Key (New)",    pattern: /sk-(?:proj-)?[a-zA-Z0-9\-_]{40,}/,                               minLength: 40,  allowsSpaces: false, highConfidence: true },
  { name: "Anthropic API Key",       pattern: /sk-ant-api[0-9]{2}-[a-zA-Z0-9\-_]{80,}/,                          minLength: 80,  allowsSpaces: false, highConfidence: true },
  { name: "Volcengine Ark API Key",  pattern: /ark-[a-zA-Z0-9\-_]{20,}/,                                        minLength: 20,  allowsSpaces: false, highConfidence: true },
  // NPM / PyPI
  { name: "NPM Token",               pattern: /npm_[a-zA-Z0-9]{36}/,                                            minLength: 36,  allowsSpaces: false, highConfidence: true },
  { name: "PyPI Token",              pattern: /pypi-[a-zA-Z0-9_\-]{50,}/,                                       minLength: 50,  allowsSpaces: false, highConfidence: true },
  // Private Keys
  { name: "RSA Private Key",         pattern: /-----BEGIN RSA PRIVATE KEY-----/,                                  minLength: 20,  allowsSpaces: true,  highConfidence: true },
  { name: "OpenSSH Private Key",     pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/,                              minLength: 20,  allowsSpaces: true,  highConfidence: true },
  { name: "EC Private Key",          pattern: /-----BEGIN EC PRIVATE KEY-----/,                                   minLength: 20,  allowsSpaces: true,  highConfidence: true },
  { name: "PGP Private Key",         pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/,                            minLength: 20,  allowsSpaces: true,  highConfidence: true },
  { name: "Generic Private Key",     pattern: /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/,                        minLength: 20,  allowsSpaces: true,  highConfidence: true },
  // Database URIs
  { name: "MongoDB Connection String", pattern: /mongodb(?:\+srv)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/,           minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "PostgreSQL Connection String", pattern: /postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/,        minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "MySQL Connection String",  pattern: /mysql:\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/,                        minLength: 20,  allowsSpaces: false, highConfidence: true },
  { name: "Redis Connection String",  pattern: /redis:\/\/[^\s'"]*:[^\s'"]+@[^\s'"]+/,                         minLength: 15,  allowsSpaces: false, highConfidence: true },
  // URL-embedded passwords
  { name: "Password in URL",         pattern: /[a-zA-Z]{3,10}:\/\/[^/\s:@]{3,20}:[^/\s:@]{3,20}@[^\s'"]+/,    minLength: 15,  allowsSpaces: false, highConfidence: true },
  // Generic assignments (lower confidence — checked against SAFE_PATTERNS)
  { name: "Bearer Token",            pattern: /[Bb]earer\s+[a-zA-Z0-9\-._~+/]+=*/,                               minLength: 15,  allowsSpaces: false, highConfidence: false },
  { name: "Basic Auth Header",       pattern: /[Bb]asic\s+[a-zA-Z0-9+/]{20,}={0,2}/,                            minLength: 20,  allowsSpaces: false, highConfidence: false },
  { name: "API Key Assignment",      pattern: /(?:api[_-]?key|apikey|api[_-]?secret)['"\s:=]+['"]?[a-zA-Z0-9\-._]{20,}['"]?/i, minLength: 20, allowsSpaces: false, highConfidence: false },
  { name: "Secret Assignment",       pattern: /(?:secret|token|password|passwd|pwd)['"\s:=]+['"]?[a-zA-Z0-9\-._!@#$%^&*]{8,}['"]?/i, minLength: 12, allowsSpaces: false, highConfidence: false },
];

// ── Safe Patterns (exclude from detection to reduce false positives) ─────────

export const SAFE_PATTERNS: RegExp[] = [
  /^https?:\/\/[a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9.\/_\-?&=#%]*)?$/,  // URLs without credentials
  /^\.\.?\/[a-zA-Z0-9_\-./]+$/,                                 // Relative file paths
  /^\/[a-zA-Z0-9_\-./]+$/,                                       // Absolute Unix paths
  /^[a-zA-Z]:\\[a-zA-Z0-9_\-\\./]+$/,                            // Windows paths
  /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,        // Email addresses
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // UUIDs
  /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/,  // Semver
  /^(?:xxx+|your[_-]?(?:api[_-]?)?key|placeholder|example|test|demo|sample)/i, // Placeholders
  /^[0-9a-f]{40}$/i,                                              // Git SHA-1
  /^[0-9a-f]{64}$/i,                                              // SHA-256
  /^@[a-z0-9-]+\/[a-z0-9-]+$/,                                   // npm scoped packages
];

export function isSafeContent(content: string): boolean {
  for (const pat of SAFE_PATTERNS) {
    if (pat.test(content)) return true;
  }
  return false;
}

// ── Detector ─────────────────────────────────────────────────────────────────

export interface SecretMatch {
  name: string;
  start: number;
  end: number;
  original: string;
}

const MIN_SCAN_LENGTH = 10;

export function detectSecrets(content: string): SecretMatch[] {
  if (content.length < MIN_SCAN_LENGTH) return [];
  const matches: SecretMatch[] = [];
  const seen = new Set<string>(); // deduplicate by position

  // Pass 1: High-confidence pattern matching (specific prefixes like ghp_, AKIA)
  for (const sp of SECRET_PATTERNS) {
    if (!sp.highConfidence) continue;
    if (content.length < sp.minLength) continue;
    for (const m of content.matchAll(new RegExp(sp.pattern.source, sp.pattern.flags + "g"))) {
      const text = m[0];
      if (!text) continue;
      if (!sp.allowsSpaces && text.includes(" ")) continue;
      const key = `${m.index}-${m.index + text.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ name: sp.name, start: m.index!, end: m.index! + text.length, original: text });
    }
  }

  // Pass 2: Low-confidence pattern matching (generic assignments like secret=xxx)
  // Skip ranges already covered by high-confidence matches
  for (const sp of SECRET_PATTERNS) {
    if (sp.highConfidence) continue;
    if (content.length < sp.minLength) continue;
    for (const m of content.matchAll(new RegExp(sp.pattern.source, sp.pattern.flags + "g"))) {
      const text = m[0];
      if (!text) continue;
      if (!sp.allowsSpaces && text.includes(" ")) continue;
      // Check against safe patterns to reduce false positives
      if (isSafeContent(text)) continue;
      // Also check surrounding context (e.g. "your_api_key=xxx" is a placeholder)
      const contextStart = Math.max(0, m.index! - 10);
      const context = content.slice(contextStart, m.index! + text.length);
      if (isSafeContent(context)) continue;
      // Skip if range already covered by a high-confidence match
      const start = m.index!, end = m.index! + text.length;
      if (matches.some(hc => hc.start <= start && hc.end >= end)) continue;
      const key = `${start}-${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ name: sp.name, start, end, original: text });
    }
  }

  // Pass 3: Entropy analysis (catches unknown formats like third-party sk- keys)
  const highEntropyTokens = findHighEntropyTokens(content);
  for (const token of highEntropyTokens) {
    if (isSafeContent(token)) continue;
    const idx = content.indexOf(token);
    if (idx === -1) continue;
    // Skip if already covered by a pattern match
    if (matches.some(m => m.start <= idx && m.end >= idx + token.length)) continue;
    const key = `${idx}-${idx + token.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ name: "High Entropy String", start: idx, end: idx + token.length, original: token });
  }

  // Sort by start position descending for safe right-to-left replacement
  return matches.sort((a, b) => b.start - a.start);
}

export function maskSecret(text: string): string {
  if (text.length <= 8) return "********";
  return text.slice(0, 4) + "********" + text.slice(-4);
}

