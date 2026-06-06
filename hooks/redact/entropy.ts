/**
 * Safety Detection — Shannon entropy and adjusted entropy analysis
 */

import { isSafeContent } from "./patterns.js";

// ─── Character classification ────────────────────────────────────────────

/** Character class: U=uppercase, L=lowercase, D=digit, S=dash, X=other */
export function charClass(c: string): "U" | "L" | "D" | "S" | "X" {
  const code = c.charCodeAt(0);
  if (code >= 65 && code <= 90) return "U";
  if (code >= 97 && code <= 122) return "L";
  if (code >= 48 && code <= 57) return "D";
  if (c === "-") return "S";
  return "X";
}

// ─── Shannon entropy ──────────────────────────────────────────────────────

/** H(X) = -Σ p(x) · log₂(p(x)) */
export function shannonEntropy(data: string): number {
  if (data.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const char of data) freq.set(char, (freq.get(char) ?? 0) + 1);
  let entropy = 0;
  const len = data.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ─── Trigram density ──────────────────────────────────────────────────────

/**
 * 3-character sliding window scoring.
 * - Pure digits → 0
 * - Letter↔Digit switch (digit in first position, e.g. 4Vi) → 1.0
 * - Contains '-' with ≥3 distinct classes → 1.0
 * - Case switch AbA pattern (≥2 uppercase + ≥1 lowercase) → 0.8
 */
export function trigramScore(c1: string, c2: string, c3: string): number {
  const cls = [charClass(c1), charClass(c2), charClass(c3)];
  if (cls.includes("X")) return 0;
  const unique = new Set(cls);
  if (unique.size === 1 && cls[0] === "D") return 0;
  if (cls.includes("S") && unique.size >= 3) return 1.0;
  const hasDigit = cls.includes("D");
  const hasLetter = cls.includes("L") || cls.includes("U");
  if (hasDigit && hasLetter && cls[0] === "D") return 1.0;
  const uCount = cls.filter(c => c === "U").length;
  const lCount = cls.filter(c => c === "L").length;
  if (uCount >= 2 && lCount >= 1) return 0.8;
  return 0;
}

/** Split a token by X-class characters into independent segments. */
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

/** Average trigram density for a single segment. */
export function segmentDensity(segment: string): number {
  if (segment.length < 3) return 0;
  let totalScore = 0;
  for (let i = 0; i <= segment.length - 3; i++) {
    totalScore += trigramScore(segment[i]!, segment[i + 1]!, segment[i + 2]!);
  }
  return totalScore / (segment.length - 2);
}

/** Maximum segment density across all X-split segments. */
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

// ─── Word / dictionary / hex ratios ───────────────────────────────────────

/**
 * Word ratio: fraction of token in vowel-containing alphabetic fragments
 * ≥3 characters. Natural language words reduce secret likelihood.
 */
export function computeWordRatio(token: string): number {
  const letterSeqs: string[] = [];
  let current = "";
  for (const c of token) {
    const cls = charClass(c);
    if (cls === "L" || cls === "U") {
      current += c.toLowerCase();
    } else {
      if (current.length >= 3) letterSeqs.push(current);
      current = "";
    }
  }
  if (current.length >= 3) letterSeqs.push(current);
  const vowels = /[aeiou]/;
  const words = letterSeqs.filter(seq => vowels.test(seq));
  return words.length > 0 ? words.reduce((sum, w) => sum + w.length, 0) / token.length : 0;
}

export function computeHexRatio(token: string): number {
  let hexCount = 0;
  const len = token.length;
  if (len === 0) return 0;
  for (const c of token) {
    if (/[0-9a-fA-F-]/.test(c)) hexCount++;
  }
  return hexCount / len;
}

/** 2121 English + tech words for dictionary coverage check */
const DICT_WORDS: ReadonlySet<string> = new Set(
    // prettier-ignore
  JSON.parse(`["ability","able","about","above","abstract","abuse","academic","accept","acceptance","accepted","access","accessories","accommodation","according","account","accounting","accounts","across","action","actions","active","activities","activity","actual","actually","added","addition","additional","address","adm","admin","administration","administrative","adult","advance","advanced","adventure","advertise","advertisement","advertising","advice","aes","affairs","affiliate","affiliates","africa","african","after","again","against","agencies","agency","agent","agents","agree","agreement","airport","album","allow","allowed","allows","almost","alone","along","already","also","alternative","although","always","amateur","amazon","america","american","among","amount","analysis","angeles","animal","animals","announcements","annual","another","answer","answers","anti","anyone","anything","apartments","api","apparel","appear","apple","application","applications","applied","apply","approach","appropriate","approval","approved","approximately","april","architecture","archive","archives","area","areas","argument","arizona","army","around","article","articles","artist","artists","arts","asia","asian","asked","assessment","assistance","assistant","associated","associates","association","attack","attention","attorney","auction","auctions","audio","august","australia","australian","auth","author","authority","authors","auto","automatically","automotive","availability","available","avenue","average","avg","avoid","award","awards","away","baby","back","background","balance","ball","band","bank","base","baseball","based","basic","basis","basket","battery","beach","beautiful","beauty","became","because","become","been","before","began","begin","beginning","behind","being","believe","below","benefit","benefits","best","better","between","beyond","bible","bill","birth","black","block","blog","blogs","blood","blue","board","boards","body","book","books","born","boston","both","bottom","boys","branch","brand","brands","break","breakfast","breast","bridge","bring","british","brought","brown","browse","browser","btn","budget","buf","build","building","built","bush","business","businesses","button","buyer","buying","cable","calendar","california","call","called","calls","came","camera","cameras","camp","campaign","campus","canada","canadian","cancer","canon","capacity","capital","card","cards","care","career","careers","carolina","cars","cart","case","cases","cash","casino","catalog","categories","category","cause","cb","cell","cells","center","centers","central","centre","century","certain","certificate","certified","cfg","chain","chair","challenge","chance","change","changed","changes","channel","chapter","character","characters","charge","charges","charles","chart","chat","cheap","check","chemical","chicago","chief","child","children","china","chinese","choice","choose","chris","christian","christmas","church","cities","city","civil","claim","claims","class","classes","classic","classifieds","clean","clear","cli","click","client","clients","clinical","close","closed","clothing","club","clubs","cnet","cnt","coast","code","codes","coffee","col","cold","collection","college","color","colorado","columbia","column","come","comes","coming","command","comment","comments","commerce","commercial","commission","committee","common","communication","communications","communities","community","companies","company","compare","compared","comparison","competition","complete","completed","complex","compliance","component","components","comprehensive","computer","computers","computing","condition","conditions","conference","configuration","congress","connect","connection","consider","considered","construction","consumer","contact","contacts","contains","content","contents","context","continue","continued","contract","control","cool","copy","copyright","core","corner","corporate","corporation","correct","cost","costs","could","council","count","counter","countries","country","county","couple","course","courses","court","cover","coverage","covered","cpu","create","created","creating","creative","credit","creek","crime","critical","cross","crud","css","csv","cultural","culture","currency","current","currently","custom","customer","customers","daily","damage","dance","dark","data","database","date","dates","dating","david","days","db","dead","deal","deals","death","debt","december","decision","deep","default","defense","define","defined","definition","degree","delivery","demand","department","described","description","design","designated","designed","desktop","detail","detailed","details","determine","determined","dev","develop","developed","developer","developing","development","device","devices","diamond","dictionary","died","diet","difference","different","difficult","digital","dir","direct","directions","directly","director","directory","disclaimer","discount","discuss","discussion","disease","disp","display","distance","distribution","district","division","dlg","dns","doctor","document","documentation","documents","does","doing","dollar","dollars","domain","domestic","done","door","double","down","download","downloads","draft","drive","driver","driving","drop","drug","drugs","dst","during","dvds","each","early","earth","easily","east","eastern","easy","ebay","economic","economy","edge","edit","edition","editor","education","educational","effect","effective","effects","effort","efforts","either","election","electric","electronic","electronics","element","elements","else","email","emergency","emit","employee","employees","employment","enable","ending","energy","engine","engineering","england","english","enjoy","enough","ensure","enter","enterprise","entertainment","entire","entries","entry","env","environment","environmental","equal","equipment","err","error","errors","especially","essential","established","estate","europe","european","evaluation","even","event","events","ever","every","everyone","everything","evidence","evt","example","examples","excellent","except","exchange","executive","exercise","existing","expect","expected","experience","expert","express","ext","extended","extension","external","extra","eyes","face","facilities","facility","fact","factor","factors","facts","faculty","failure","fair","faith","fall","families","family","fantasy","farm","fashion","fast","father","favorite","feat","feature","featured","features","february","federal","feed","feedback","feel","fees","feet","female","fiction","field","fields","figure","file","files","fill","film","films","filter","final","finally","finance","financial","find","finding","fine","fire","firm","first","fish","fishing","fitness","five","fixed","fixme","flag","flash","flat","flight","floor","florida","flow","flowers","focus","follow","following","follows","font","food","foot","football","force","ford","foreign","forest","form","format","former","forms","forum","forums","forward","found","foundation","four","frame","france","francisco","free","freedom","french","fresh","friday","friend","friendly","friends","from","front","ftr","fuel","full","fully","function","functional","functions","fund","funding","funds","furniture","further","future","galleries","gallery","game","games","gamma","garden","gave","gear","general","generally","generated","generation","george","georgia","german","germany","gets","getting","gid","gift","gifts","girl","girls","git","give","given","gives","giving","glass","global","goal","goals","goes","going","gold","golden","golf","gone","good","goods","google","government","gpt","gpu","grade","graduate","grand","grant","graphics","great","greater","green","ground","group","groups","growing","growth","grp","guarantee","guest","gui","guide","guidelines","guides","guitar","guys","hack","hair","half","hall","hand","hands","happy","hard","hardware","have","having","hdr","head","headlines","health","hear","heard","hearing","heart","heat","heavy","held","help","helpful","here","high","higher","highest","highly","hill","himself","hire","historical","history","hits","hold","holiday","holidays","home","homepage","homes","hook","hope","horse","hospital","host","hosting","hotel","hotels","hour","hours","house","housing","houston","however","html","huge","human","icon","idea","ideas","identify","idx","illinois","image","images","img","immediately","impact","implementation","important","improve","improvement","inch","include","included","includes","including","income","increase","increased","independent","index","india","indian","individual","individuals","industrial","industry","info","information","informed","initial","input","inside","install","installation","instead","institute","institutions","instructions","instruments","insurance","int","integrated","intended","interactive","interest","interested","interesting","interests","interface","internal","international","internet","into","introduction","investment","involved","ipod","iraq","ireland","isbn","island","islands","israel","issue","issues","italian","italy","item","items","itself","jack","jackson","james","january","japan","japanese","java","jersey","jesus","jewelry","jobs","john","johnson","join","joined","joint","jones","journal","json","july","jump","june","just","justice","kansas","keep","key","keyword","keywords","kids","kind","kinds","king","kingdom","kitchen","know","knowledge","known","kong","label","labor","lake","lan","land","language","languages","large","larger","largest","last","late","later","latest","latin","laws","lead","leader","leaders","leadership","leading","league","learn","learning","least","leather","leave","left","legal","len","length","lesbian","less","letter","letters","level","levels","lib","library","license","life","light","like","likely","limit","limited","line","lines","link","links","linux","list","listed","listen","listing","listings","lists","literature","little","live","lives","living","llm","load","loan","loans","local","located","location","locations","login","logo","london","long","longer","look","looking","looks","lord","loss","lost","lots","louis","love","lower","lowest","lyrics","mac","machine","machines","made","magazine","magazines","magic","mail","mailing","main","maintenance","major","make","makes","making","male","manage","management","manager","manual","manufacturer","manufacturing","many","maps","march","marine","mark","market","marketing","markets","martin","mary","mass","master","match","matching","material","materials","matter","mature","max","maximum","maybe","mean","means","measures","media","medical","medicine","medium","meet","meeting","meetings","mega","member","members","membership","memory","mental","menu","merchant","message","messages","metal","method","methods","mexico","michael","michigan","micro","microsoft","middle","might","mike","miles","military","million","min","mind","mini","minimum","minister","minnesota","minute","minutes","miss","missing","mission","mobile","mock","mod","mode","model","models","modern","modified","module","moment","monday","money","monitor","monitoring","month","monthly","months","more","morning","mortgage","most","mother","motion","motor","motorola","mount","mountain","move","moved","movement","movie","movies","moving","msg","much","multi","multimedia","multiple","museum","music","musical","must","myself","naked","name","names","nano","nation","national","native","natural","nature","nav","navigation","near","necessary","need","needed","needs","net","network","networking","networks","never","news","newsletter","next","nice","night","nlp","nokia","none","normal","north","northern","note","notes","nothing","notice","november","npm","num","number","numbers","nursing","oauth","object","october","offer","offered","offering","offers","office","officer","official","often","ohio","older","once","ones","online","only","ontario","open","opening","operating","operation","operations","opinion","opportunities","opportunity","ops","option","optional","options","oral","orange","order","orders","oregon","organization","organizations","original","orm","oss","other","others","otherwise","outdoor","output","outside","over","overall","overview","owned","owner","owners","pacific","pack","package","packages","page","pages","paid","pain","palm","panel","paper","paperback","papers","parent","parents","paris","park","parking","part","particular","particularly","parties","partner","partners","parts","party","pass","password","past","patch","path","patient","patients","paul","payment","paypal","peace","pennsylvania","people","percent","perfect","performance","perhaps","period","perm","permission","person","personal","persons","peter","phase","phentermine","phone","phones","photo","photography","photos","physical","pick","pics","picture","pictures","pid","piece","pink","pip","pipe","pkg","place","placed","places","plan","planning","plans","plant","plants","plastic","platform","play","played","player","players","playing","please","plus","pocket","point","points","poker","pol","police","policies","policy","political","politics","pool","poor","pop","popular","population","port","pos","position","positive","possible","post","posted","poster","posters","posts","potential","power","powered","practice","practices","premium","present","presentation","presented","president","press","pressure","pretty","prev","prevent","previous","price","prices","pricing","primary","prime","print","printer","printing","prior","privacy","private","pro","probably","problem","problems","procedure","procedures","process","processes","processing","prod","produce","produced","product","production","products","professional","professor","profile","profit","program","programme","programming","programs","progress","project","projects","properties","property","proposed","protect","protection","protein","provide","provided","provider","providers","provides","providing","ptr","public","publication","publications","published","publisher","publishing","purchase","purpose","purposes","quality","quantity","quarter","question","questions","quick","quickly","quite","quote","quotes","race","racing","radio","ram","random","range","rank","rate","rated","rates","rather","rating","ratings","reach","read","reader","readers","reading","ready","real","really","reason","reasons","receive","received","recent","recently","recipes","recommend","recommendations","recommended","record","records","recovery","reduce","ref","reference","references","regarding","region","regional","register","registered","registration","regular","regulations","related","relations","relationship","release","released","releases","relevant","religion","religious","remember","remote","remove","rent","rental","rentals","repair","replies","reply","report","reported","reporting","reports","republic","req","request","requests","require","required","requirements","requires","res","research","reserve","reserved","resolution","resort","resource","resources","respect","respective","response","responsibility","responsible","rest","restaurant","restaurants","result","results","retail","return","returns","rev","review","reviews","rich","richard","right","rights","ring","ringtones","risk","river","road","robert","rock","rol","role","room","rooms","root","rose","round","row","royal","rsa","rule","rules","running","russia","russian","safe","safety","said","saint","sale","sales","same","sample","samsung","santa","satellite","saturday","save","saying","says","scale","schedule","school","schools","science","sciences","scientific","score","scott","screen","sdk","search","searches","season","seattle","second","seconds","secretary","section","sections","sector","secure","security","seem","seems","seen","select","selected","selection","self","sell","seller","sellers","selling","send","senior","sense","sent","separate","september","sequence","series","serious","serve","server","servers","service","services","session","sets","setting","settings","seven","several","sha","shall","share","sheet","ship","shipping","ships","shirt","shirts","shoes","shop","shopping","shops","short","shot","should","show","showing","shown","shows","sid","side","sign","signed","significant","silver","similar","simple","simply","since","single","site","sitemap","sites","situation","size","skills","skin","skip","small","smart","smith","snow","social","society","soft","software","sold","solid","solution","solutions","some","someone","something","sometimes","song","songs","sony","soon","sorry","sort","sorted","sound","source","sources","south","southern","space","spain","spanish","special","species","specific","specified","speed","spirit","sponsored","sport","sports","spring","sql","square","src","sre","ssd","ssh","ssl","staff","stage","stand","standard","standards","star","stars","start","started","starting","state","statement","statements","states","station","statistics","status","stay","steel","step","steps","steve","still","stock","stone","stop","storage","store","stores","stories","story","str","strategies","strategy","stream","street","string","strong","structure","stub","student","students","studies","studio","study","stuff","style","subject","subjects","submit","submitted","subs","subscribe","success","successful","such","suggest","suite","sum","summary","summer","sunday","super","supplies","supply","support","supported","sure","surface","surgery","survey","switch","system","systems","tab","table","tables","tag","tags","take","taken","takes","taking","talk","talking","target","task","tcp","teacher","teachers","teaching","team","tech","technical","techniques","technologies","technology","teen","teens","telephone","television","tell","temp","temperature","term","terms","test","testing","tests","texas","text","than","thank","thanks","that","their","them","theme","themselves","then","theory","therapy","there","therefore","these","they","thing","things","think","thinking","third","this","thomas","those","though","thought","thoughts","thousands","thread","three","through","throughout","thursday","thus","tickets","tid","time","times","tip","tips","title","titles","tls","tmp","today","todo","together","told","took","tool","tools","topic","topics","total","touch","tour","tours","towards","town","toys","track","trade","trademarks","trading","traditional","traffic","training","transfer","transport","transportation","travel","treatment","tree","trial","trip","true","trust","truth","trying","tuesday","turn","type","types","udp","uid","under","understand","understanding","union","unique","unit","united","units","universal","university","unknown","unless","until","update","updated","updates","upgrade","upon","upper","urban","url","used","useful","user","username","users","uses","using","usr","usually","vacation","val","valid","valley","value","values","variable","variety","various","vegas","vehicle","vehicles","ver","version","very","video","videos","view","viewed","views","village","virginia","virtual","virus","vision","visit","visitors","visual","voice","volume","vote","vpn","wait","walk","wall","wan","want","wanted","warning","washington","waste","watch","watches","water","ways","weather","website","websites","wedding","wednesday","week","weekend","weekly","weeks","weight","welcome","well","went","were","west","western","what","when","where","whether","which","while","white","whole","wholesale","whose","wide","wife","wild","will","william","williams","wind","window","windows","wine","winter","wireless","wish","with","within","without","woman","women","wood","word","words","work","worked","workers","working","works","workshop","world","worldwide","worth","would","write","writing","written","wrong","wrote","xbox","xml","yahoo","yaml","year","years","yellow","yesterday","york","young","your","yourself","youth","zealand","zone"]`)
);

/**
 * Dict ratio: fraction covered by dictionary words.
 * High dict ratio → likely English text / identifier, not a secret.
 */
export function computeDictRatio(token: string): number {
  // Extract alphabetic sequences (>= 3 chars), case-insensitive
  const lowerSeqs: string[] = [];
  let current = "";
  for (const c of token) {
    const cls = charClass(c);
    if (cls === "L" || cls === "U") {
      current += c.toLowerCase();
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

// ─── Adjusted entropy ─────────────────────────────────────────────────────

export const ENTROPY_THRESHOLD = 5.5;
export const MIN_ENTROPY_TOKEN_LENGTH = 32;
const W1_DENSITY = 3.0;
const W2_WORD = 3.0;
const W3_DICT = 4.0;
const HEX_PENALTY = 2.5;
const HEX_RATIO_THRESHOLD = 0.9;

/**
 * Adjusted entropy:
 *   adjusted = baseShannon + trigramDensity×W1 - wordRatio×W2 - dictRatio×W3 - hexPenalty
 *
 * Hex penalty only applies for hyphenated UUID-like tokens
 * (>90% hex AND contains '-').
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
  const hp = (hexRatio > HEX_RATIO_THRESHOLD && data.includes("-")) ? HEX_PENALTY : 0;
  return base + densityBoost - wordPenalty - dictPenalty - hp;
}

export function isHighEntropy(data: string): boolean {
  if (data.length < MIN_ENTROPY_TOKEN_LENGTH) return false;
  if (isSafeContent(data)) return false;
  return calculateAdjustedEntropy(data) > ENTROPY_THRESHOLD;
}

/**
 * Split by whitespace — the most conservative tokenization.
 * Preserves JSON structure, URLs, and connection strings.
 */
export function findHighEntropyTokens(content: string): string[] {
  const tokens = content.split(/[\s\[\]{}"',\/\\|()&#@!<>?]+/);
  return tokens.filter(t => t.length >= MIN_ENTROPY_TOKEN_LENGTH && isHighEntropy(t));
}
