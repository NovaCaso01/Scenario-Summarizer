/**
 * 시나리오 자동요약 - 상수 및 기본 설정
 */

// 확장 기본 정보
export const extensionName = "scenario-summarizer";

// 확장 폴더 경로 - 동적으로 감지
// SillyTavern은 third-party 또는 data/user/extensions 경로를 사용할 수 있음
function detectExtensionPath() {
    // 현재 스크립트의 경로에서 추출 시도
    try {
        const scripts = document.querySelectorAll('script[src*="scenario-summarizer"], script[src*="Scenario-Summarizer"]');
        for (const script of scripts) {
            const src = script.src;
            const match = src.match(/(.+?(?:scenario-summarizer|Scenario-Summarizer))/i);
            if (match) {
                // URL에서 상대 경로 추출
                const url = new URL(match[1]);
                return url.pathname.replace(/^\//, '');
            }
        }
    } catch (e) {
        console.warn('[scenario-summarizer] Script path detection failed:', e);
    }
    
    // import.meta.url 사용 시도 (ES modules)
    try {
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            const url = new URL(import.meta.url);
            const pathParts = url.pathname.split('/');
            // constants.js는 src/ 폴더 안에 있으므로 상위 폴더 경로 추출
            const extIndex = pathParts.findIndex(p => 
                p.toLowerCase() === 'scenario-summarizer' || p === 'Scenario-Summarizer'
            );
            if (extIndex !== -1) {
                return pathParts.slice(1, extIndex + 1).join('/');
            }
        }
    } catch (e) {
        console.warn('[scenario-summarizer] import.meta.url detection failed:', e);
    }
    
    // 폴백: 여러 가능한 경로 시도
    return `scripts/extensions/third-party/${extensionName}`;
}

export const extensionFolderPath = detectExtensionPath();
export const METADATA_KEY = "scenario_summarizer";
export const DATA_VERSION = 4; // 데이터 구조 버전 (마이그레이션용) - v4: events, items 추가

// API 소스 타입
export const API_SOURCE = {
    SILLYTAVERN: "sillytavern",
    CUSTOM: "custom"
};

// 기본 설정값
export const defaultSettings = {
    // 기본 활성화
    enabled: true,
    automaticMode: false,          // 자동 요약 on/off (기본 OFF)
    
    // 요약 설정
    summaryInterval: 10,           // N개 메세지마다 자동 요약
    batchSize: 10,                 // 한 번에 처리할 메세지 수
    preserveRecentMessages: 5,     // 숨기지 않을 최근 메세지 수
    
    // 요약 모드 설정
    summaryMode: "batch",         // "individual" = 개별 메세지별, "batch" = N개를 하나로 묶어서
    batchGroupSize: 5,             // batch 모드일 때 몇 개씩 묶어서 요약할지
    
    // 요약 언어 설정
    summaryLanguage: "en",         // "ko" = 한국어, "en" = English, "ja" = 日本語, "hybrid" = 대사 원문 유지
    
    // Auto-Hide 설정
    autoHideEnabled: true,         // 요약된 메세지 자동 숨김
    
    // 등장인물 추적 설정
    characterTrackingEnabled: false, // 요약 시 등장인물 자동 추출/업데이트 (기본 OFF)
    
    // 이벤트/아이템 추적 설정
    eventTrackingEnabled: false,   // 요약 시 주요 이벤트 자동 추출 (기본 OFF)
    itemTrackingEnabled: false,    // 요약 시 주요 아이템 자동 추출 (기본 OFF)
    
    // 월드인포 포함 여부
    includeWorldInfo: false,       // 요약 시 World Info 포함 여부
    
    // 주입 위치 설정
    injectionPosition: "after-main",  // "in-chat" (채팅 내 지정 깊이), "before-main" (메인 프롬프트 전), "after-main" (메인 프롬프트 후)
    injectionDepth: 0,             // in-chat 모드일 때 주입 깊이 (0 = 채팅 메시지 직전)
    
    // 토큰 예산
    tokenBudget: 20000,            // 주입할 최대 토큰 수
    
    // 요약 컨텍스트 (일관성 유지용)
    summaryContextCount: 5,        // 요약 시 참조할 이전 요약 수 (0 = 사용 안 함, -1 = 전체)
    
    // 요약 카테고리 (각 항목별 활성화 + 커스텀 프롬프트)
    categories: {
        scenario: {
            enabled: true,
            label: "Scenario",
            icon: "📖",
            prompt: "Summarize the cause-and-effect flow of events narratively. Focus on 'who did what and why' rather than simple enumeration. Include important dialogue using double quotes (\"\") with direct quotation from the original text to maintain character voice."
        },
        emotion: {
            enabled: false,
            label: "Emotion",
            icon: "😊",
            prompt: "Write each line as '- CharacterName: Emotion (cause)'. Separate by character using line breaks. Example: - {{user}}: Bewilderment (due to sudden confession)"
        },
        innerThoughts: {
            enabled: false,
            label: "Inner Thoughts",
            icon: "💭",
            prompt: "Record ONLY inner monologues or thoughts explicitly shown in the message. Do NOT speculate or fabricate. Write only what is directly expressed in text as '- CharacterName: \"inner thought\"'. If no explicit inner thoughts exist, write 'N/A'."
        },
        atmosphere: {
            enabled: false,
            label: "Atmosphere",
            icon: "🌙",
            prompt: "Briefly describe the scene's overall tension, tone, and mood with adjectives. (e.g., dark and humid, tense, peaceful)"
        },
        location: {
            enabled: true,
            label: "Location",
            icon: "📍",
            prompt: "Briefly specify the physical location where characters are. Use arrow (→) if there was movement. If no movement, write same as previous."
        },
        date: {
            enabled: false,
            label: "Date",
            icon: "📅",
            prompt: "Infer the date from context (mentions of days, events, seasons, holidays, etc.). Write as 'Month/Day(DayOfWeek)' format (e.g., 25/12/25(Wed), 25/1/1(Mon)). If cannot be determined, estimate based on context clues. If same as previous summary, maintain it."
        },
        time: {
            enabled: true,
            label: "Time",
            icon: "⏰",
            prompt: "Specify the time of day (dawn, night, etc.). If no change from previous summary, write same as previous."
        },
        relationship: {
            enabled: true,
            label: "Relationship",
            icon: "💕",
            prompt: "Define the current relationship between the two characters with a noun that best describes it. (e.g., neighbors, lovers) If a relationship was defined in previous summary, maintain it unless there's a clear change."
        }
    },
    
    // API 설정
    apiSource: API_SOURCE.SILLYTAVERN,
    useRawPrompt: true,            // Raw 프롬프트 사용 (캐릭터 카드 Scenario 제외)
    stConnectionProfile: "",       // SillyTavern Connection Manager 프로필 (빈 문자열 = 현재 연결 사용)
    customApiUrl: "",
    customApiKey: "",
    customApiModel: "",
    customApiMaxTokens: 4000,      // Custom API max_tokens
    customApiTimeout: 60,          // Custom API timeout (초)
    
    // 커스텀 API 프리셋
    apiPresets: [],                // [{name, url, key, model}, ...]
    selectedPreset: "",            // 현재 선택된 프리셋 이름
    
    // 커스텀 프롬프트 (null이면 기본 프롬프트 사용)
    customPromptTemplate: null,           // 개별 요약 프롬프트
    customBatchPromptTemplate: null,      // 그룹 요약 프롬프트
    customCharacterPromptTemplate: null,  // 등장인물 추출 프롬프트
    customEventPromptTemplate: null,      // 이벤트 추출 프롬프트
    customItemPromptTemplate: null,       // 아이템 추출 프롬프트
    
    // 프롬프트 프리셋 (종류별)
    promptPresets: [],                    // 개별 요약 프리셋 [{name, template}, ...]
    batchPromptPresets: [],               // 그룹 요약 프리셋
    characterPromptPresets: [],           // 등장인물 추출 프리셋
    eventPromptPresets: [],               // 이벤트 추출 프리셋
    itemPromptPresets: [],                // 아이템 추출 프리셋
    selectedPromptPreset: "",             // 개별 요약 선택된 프리셋
    selectedBatchPromptPreset: "",        // 그룹 요약 선택된 프리셋
    selectedCharacterPromptPreset: "",    // 등장인물 추출 선택된 프리셋
    selectedEventPromptPreset: "",        // 이벤트 추출 선택된 프리셋
    selectedItemPromptPreset: "",         // 아이템 추출 선택된 프리셋
    
    // 디버그
    debugMode: false,
    
    // UI 테마
    uiTheme: "mono-gray",         // "mono-gray", "dusty-rose", "ocean-breeze", "matcha-garden"
    
    // 카테고리 순서 (키 배열)
    categoryOrder: ["scenario", "emotion", "innerThoughts", "atmosphere", "location", "date", "time", "relationship"]
};

// ===== 언어별 지시 상수 =====
// 요약 프롬프트에서 사용하는 언어 지시문 (중복 방지)

export const LANG_INSTRUCTIONS = {
    'ko': `###### 🚨 CRITICAL LANGUAGE REQUIREMENT 🚨 ######
**[절대 필수] 모든 출력은 반드시 한국어로 작성하세요.**
- 요약 본문: 한국어
- 대사 인용: 한국어
- 카테고리 라벨: 한국어 (시나리오, 장소, 시간, 관계 등)
##########################################`,
    'en': `###### 🚨 CRITICAL LANGUAGE REQUIREMENT 🚨 ######
**[MANDATORY] Write EVERYTHING in English.**
- Summary text: English
- Dialogue quotes: Translate to English
- Category labels: English
DO NOT keep any non-English text. Translate ALL dialogue.
##########################################`,
    'ja': `###### 🚨 重要な言語要件 🚨 ######
**【絶対必須】すべての出力は日本語で作成してください。**
- 要約本文：日本語
- 台詞引用：日本語に翻訳
- カテゴリラベル：日本語
##########################################`,
    'hybrid': `###### 🚨 CRITICAL LANGUAGE REQUIREMENT - HYBRID MODE 🚨 ######
**[MANDATORY - READ CAREFULLY]**

✅ SUMMARY/NARRATIVE TEXT → Write in **ENGLISH**
   Example: "In the late evening, Han Do-yoon encountered Woo Min-jeong..."

✅ DIALOGUE/QUOTES → Keep in **ORIGINAL LANGUAGE** (DO NOT TRANSLATE)
   Example: If original is Korean "안녕하세요" → keep as "안녕하세요"
   Example: If original is Japanese "こんにちは" → keep as "こんにちは"

✅ CATEGORY LABELS → Write in **ENGLISH** (Location, Time, Relationship, etc.)

⚠️ WRONG: Translating dialogue to English
⚠️ WRONG: Writing narrative in Korean/Japanese
✅ CORRECT: English narrative + Original language dialogue in quotes

Example output:
* Scenario: Do-yoon greeted her warmly, saying "어? 이제 오세요?" while hiding his true intentions.
* Location: Villa Hallway
##########################################`
};

export const LANG_REMINDERS = {
    'ko': '\n🚨 **[최종 리마인더] 아래 출력을 반드시 한국어로 작성하세요!** 🚨\n',
    'en': '\n🚨 **[FINAL REMINDER] Write ALL output below in ENGLISH! Translate all dialogue!** 🚨\n',
    'ja': '\n🚨 **【最終リマインダー】以下の出力はすべて日本語で！** 🚨\n',
    'hybrid': '\n🚨 **[FINAL REMINDER - HYBRID MODE]** 🚨\n**Narrative = ENGLISH | Dialogue in quotes = ORIGINAL LANGUAGE (한국어/日本語/etc.)**\nDO NOT translate the dialogue! Keep "quoted text" exactly as in source!\n'
};

// ===== 기본 프롬프트 템플릿 =====
// 사용자는 "지침" 부분만 수정 가능
// 메시지, 등장인물, 출력 형식은 시스템이 자동 추가

// 개별 요약 - 사용자 수정 가능 부분 (지침만)
export const DEFAULT_PROMPT_TEMPLATE = `You are a skilled writer and editor who weaves extensive roleplay logs into a cohesive narrative flow.

## Mission
Analyze the provided single message and extract/summarize information according to the specified categories.

## Writing Principles
1. **Objectivity:** Base your writing on facts presented in the text, not your subjective interpretation.
2. **Contextual Connection:** Instead of simple enumeration, connect events narratively to show cause-and-effect relationships.
3. **Priority Judgment:** Boldly omit trivial greetings or meaningless chatter; focus on actions, events, and dialogue essential to story progression.
4. **Consistency:** End sentences with dry, clear declarative statements (e.g., "~did.").
5. **Continuity (CRITICAL):** 
   - If time/location/relationship has NOT changed: Write the EXACT SAME value as the previous summary
   - Example: Previous was "연인" → Write "연인" (NOT "동일", "동일함", "same", or "unchanged")
   - Only write a NEW value when there is a clear, definite change in the story


## ⚠️ CRITICAL: Output Format Rules
**YOU MUST follow this EXACT format. Any deviation will cause parsing failure.**

1. **MANDATORY:** Start EACH message with "#MessageNumber" header on its own line
2. Start each category line with "* " (asterisk + space)
3. Use format: "* CategoryLabel: content"
4. Separate messages with blank line
5. Do NOT use markdown bold (**), bullets (-), or other decorations
6. Do NOT skip any enabled categories
7. **NEVER skip the message header - system CANNOT parse without it**

CORRECT example:
#0
* Scenario: content here
* Location: content here

#1
* Scenario: content here
* Location: content here

WRONG (will cause failure):
* Scenario: content here (missing #0 header!)`;

// 묶음 요약 - 사용자 수정 가능 부분 (지침만)
export const DEFAULT_BATCH_PROMPT_TEMPLATE = `You are a skilled writer and editor who weaves extensive roleplay logs into a cohesive narrative flow.

## Mission
Integrate multiple messages (chunks) into a single, naturally flowing narrative summary.

## Writing Principles
1. **Objectivity:** Base your writing on facts presented in the text, not your subjective interpretation.
2. **Contextual Connection:** Instead of simple enumeration, connect events narratively to show cause-and-effect relationships.
3. **Priority Judgment:** Boldly omit trivial greetings or meaningless chatter; focus on actions, events, and dialogue essential to story progression.
4. **Consistency:** End sentences with dry, clear declarative statements (e.g., "~did.").
5. **Continuity (CRITICAL):** 
   - If time/location/relationship has NOT changed: Write the EXACT SAME value as the previous summary
   - Example: Previous was "연인" → Write "연인" (NOT "동일", "동일함", "same", or "unchanged")
   - Only write a NEW value when there is a clear, definite change in the story

## ⚠️ CRITICAL: Output Format Rules
**YOU MUST follow this EXACT format. Any deviation will cause parsing failure.**

1. **MANDATORY:** Start EACH group with "#StartNum-EndNum" header on its own line
2. Start each category line with "* " (asterisk + space)
3. Use format: "* CategoryLabel: content"
4. Separate groups with blank line
5. Do NOT use markdown bold (**), bullets (-), or other decorations
6. **NEVER skip the group header - system CANNOT parse without it**

CORRECT example:
#0-4
* Scenario: content here
* Location: content here

#5-9
* Scenario: content here
* Location: content here

WRONG (will cause failure):
* Scenario: content here (missing #0-4 header!)`;

// 등장인물 추출 - 사용자 수정 가능 부분 (지침만)
export const DEFAULT_CHARACTER_PROMPT_TEMPLATE = `Generate profiles for **key characters** who impact the story from the following text.

## Extraction Guidelines
1. **Profile Info Priority:** Always use information already specified in the character profile as-is. Do not infer from message content.
2. **Evidence-Based:** For new characters without profiles, only include what is explicitly stated or strongly implied in the text.
3. **Exclusions:** Exclude characters with no dialogue or background extras who appear briefly.
4. **Format:** Strictly follow the specified JSON format for each character. Write 'N/A' for fields with no information.`;

// 캐릭터 추출 JSON 블록 (요약에 포함될 때 사용) - 언어별 버전
// 마커 형식으로 변경하여 파싱 실패율 대폭 감소
export const CHARACTER_EXTRACTION_BLOCKS = {
    ko: `
## Character Extraction
**Output [CHARACTERS] block for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions)
- **IMPORTANT: If character IS {{user}}, set relationship to "본인" (self)**

### Output Format (one line per character)
[CHARACTERS]
캐릭터이름 | 역할 | 나이 | 직업 | 외모 | 성격특성(쉼표구분) | {{user}}와의관계 | 첫등장메시지번호
[/CHARACTERS]

### Example
[CHARACTERS]
엘리스 | 주인공의 동료 | 24 | 마법사 | 금발, 파란 눈, 165cm | 외향적, 호기심 많음, 다정함 | 소꿉친구 | 42
고블린왕 | 악역 | 불명 | 군주 | 거대한 체구, 녹색 피부 | 잔인함, 교활함 | 적 | 58
[/CHARACTERS]

- Use | as delimiter
- Write "N/A" for unknown fields
- If no new characters or changes, output empty block: [CHARACTERS][/CHARACTERS]`,

    en: `
## Character Extraction
**Output [CHARACTERS] block for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions)
- **IMPORTANT: If character IS {{user}}, set relationship to "self"**

### Output Format (one line per character)
[CHARACTERS]
CharacterName | Role | Age | Occupation | Appearance | Traits(comma-separated) | RelationshipWithUser | FirstAppearanceMessageNumber
[/CHARACTERS]

### Example
[CHARACTERS]
Alice | protagonist's ally | 24 | mage | blonde, blue eyes, 165cm | outgoing, curious, kind | childhood friend | 42
Goblin King | antagonist | unknown | monarch | massive build, green skin | cruel, cunning | enemy | 58
[/CHARACTERS]

- Use | as delimiter
- Write "N/A" for unknown fields
- If no new characters or changes, output empty block: [CHARACTERS][/CHARACTERS]`,

    ja: `
## Character Extraction
**Output [CHARACTERS] block for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions)
- **IMPORTANT: If character IS {{user}}, set relationship to "本人" (self)**

### Output Format (one line per character)
[CHARACTERS]
キャラクター名 | 役割 | 年齢 | 職業 | 外見 | 性格特性(カンマ区切り) | {{user}}との関係 | 初登場メッセージ番号
[/CHARACTERS]

### Example
[CHARACTERS]
エリス | 主人公の仲間 | 24 | 魔法使い | 金髪、青い目、165cm | 外向的、好奇心旺盛、優しい | 幼馴染 | 42
ゴブリン王 | 敵役 | 不明 | 君主 | 巨大な体格、緑の肌 | 残忍、狡猾 | 敵 | 58
[/CHARACTERS]

- Use | as delimiter
- Write "N/A" for unknown fields
- If no new characters or changes, output empty block: [CHARACTERS][/CHARACTERS]`,

    zh: `
## Character Extraction
**Output [CHARACTERS] block for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions)
- **IMPORTANT: If character IS {{user}}, set relationship to "本人" (self)**

### Output Format (one line per character)
[CHARACTERS]
角色名 | 角色 | 年龄 | 职业 | 外貌 | 性格特征(逗号分隔) | 与{{user}}的关系 | 首次出现消息编号
[/CHARACTERS]

### Example
[CHARACTERS]
爱丽丝 | 主角的伙伴 | 24 | 法师 | 金发、蓝眼、165cm | 外向、好奇、善良 | 青梅竹马 | 42
哥布林王 | 反派 | 不明 | 君主 | 巨大身材、绿色皮肤 | 残忍、狡猾 | 敌人 | 58
[/CHARACTERS]

- Use | as delimiter
- Write "N/A" for unknown fields
- If no new characters or changes, output empty block: [CHARACTERS][/CHARACTERS]`
};

/**
 * 캐릭터 블록 제거용 정규식 생성 함수
 * 마커 형식 [CHARACTERS]...[/CHARACTERS] 매칭
 * @returns {RegExp}
 */
export function getCharacterJsonCleanupPattern() {
    // 새 마커 형식과 구버전 JSON 형식 모두 지원
    return /\[CHARACTERS(?:_JSON)?\]\s*[\s\S]*?\s*\[\/.{0,5}CHARACTERS(?:_JSON)?\]/gi;
}

// ===== 이벤트/아이템 추출 프롬프트 =====

// 이벤트 추출 - 기본 프롬프트 템플릿 (영어, 유저 수정 가능)
export const DEFAULT_EVENT_PROMPT_TEMPLATE = `## Key Event Extraction Guidelines (Very Strict)

⚠️ **Extract ONLY truly pivotal moments. Most messages will have NO events to extract.**

### Extraction Criteria (ALL must apply)
- ✅ Decisive moments that affect the entire story
- ✅ Turning points that completely change the narrative
- ✅ Events significant enough to be remembered throughout

### Examples to Extract
- Confessions/Proposals/Engagements/Marriages
- Major secret revelations or discoveries
- Breakups/Separations/Reunions
- Significant promises or vows
- Life-or-death crisis situations

### ❌ NEVER Extract
- Everyday conversations, meals, walks
- Simple emotional expressions or affection
- Recurring daily events
- Minor arguments or misunderstandings

⚠️ When in doubt, don't extract. If no events, don't output the JSON block.`;

// 이벤트 추출 - 출력 형식 블록 (언어별, 시스템 자동 추가)
// 마커 형식으로 변경하여 파싱 실패율 대폭 감소
export const EVENT_OUTPUT_FORMAT_BLOCKS = {
    'ko': `
### 출력 형식 (이벤트가 있을 경우만, 한 줄에 하나씩)
[EVENTS]
이벤트제목 | 설명 | 참여자(쉼표구분) | 중요도(high/medium/low) | 메시지번호
[/EVENTS]

### Example
[EVENTS]
첫 고백 | {{user}}가 엘리스에게 고백했다 | {{user}}, 엘리스 | high | 42
마을 습격 | 고블린 무리가 마을을 공격함 | 고블린왕, 마을사람들 | high | 58
[/EVENTS]

- 이벤트가 없으면 이 블록을 출력하지 마세요.`,
    'en': `
### Output Format (only if events exist, one per line)
[EVENTS]
EventTitle | Description | Participants(comma-separated) | Importance(high/medium/low) | MessageNumber
[/EVENTS]

### Example
[EVENTS]
First Confession | {{user}} confessed to Alice | {{user}}, Alice | high | 42
Village Attack | Goblin horde attacked the village | Goblin King, villagers | high | 58
[/EVENTS]

- If no events, don't output this block.`,
    'ja': `
### 出力形式（イベントがある場合のみ、1行に1つ）
[EVENTS]
イベントタイトル | 説明 | 参加者(カンマ区切り) | 重要度(high/medium/low) | メッセージ番号
[/EVENTS]

### Example
[EVENTS]
初告白 | {{user}}がエリスに告白した | {{user}}, エリス | high | 42
村襲撃 | ゴブリンの群れが村を攻撃 | ゴブリン王, 村人たち | high | 58
[/EVENTS]

- イベントがなければこのブロックを出力しないでください。`
};

// 아이템 추출 - 기본 프롬프트 템플릿 (영어, 유저 수정 가능)
export const DEFAULT_ITEM_PROMPT_TEMPLATE = `## Key Item Extraction Guidelines

Extract ONLY items that play a **crucial role in story development**.

### Extraction Criteria (ALL must apply)
- ✅ Items with **direct impact** on story or relationship development
- ✅ Items likely to be mentioned again or become important later
- ✅ Items with special meaning between characters

### Examples to Extract
- Jewelry/accessories **personally gifted or received**
- Items symbolizing relationships (couple rings, necklaces)
- Keys, keycards - **tools necessary for plot**
- Character's **core belongings** (always carried)

### ❌ Do NOT Extract
- Food, drinks, daily consumables
- Borrowed/worn clothing 
- Regular clothes, underwear, uniforms
- Temporary outfits (unless symbolically significant like a wedding dress)
- Furniture, appliances, buildings (background)
- Items mentioned only once
- Generic everyday items

⚠️ If unsure, don't extract. If no items, don't output the JSON block.`;

// 아이템 추출 - 출력 형식 블록 (언어별, 시스템 자동 추가)
// 마커 형식으로 변경하여 파싱 실패율 대폭 감소
export const ITEM_OUTPUT_FORMAT_BLOCKS = {
    'ko': `
### 출력 형식 (한 줄에 하나씩)
[ITEMS]
아이템명 | 스토리에서의 의미 | 현재 소유자 | 획득 경위 | 상태(보유중/사용함/분실/양도/파손) | 메시지번호
[/ITEMS]

### Example
[ITEMS]
마법검 | 전설의 검, 불속성 공격력+10 | {{user}} | 던전에서 획득 | 보유중 | 42
커플링 | 엘리스와의 약속의 증표 | {{user}} | 엘리스에게 선물받음 | 보유중 | 58
[/ITEMS]

- 아이템이 없으면 이 블록을 출력하지 마세요.`,
    'en': `
### Output Format (one per line)
[ITEMS]
ItemName | MeaningInStory | CurrentOwner | HowObtained | Status(possessed/used/lost/transferred/broken) | MessageNumber
[/ITEMS]

### Example
[ITEMS]
Magic Sword | legendary sword, fire attack+10 | {{user}} | found in dungeon | possessed | 42
Couple Ring | promise token with Alice | {{user}} | gift from Alice | possessed | 58
[/ITEMS]

- If no items, don't output this block.`,
    'ja': `
### 出力形式（1行に1つ）
[ITEMS]
アイテム名 | ストーリーでの意味 | 現在の所有者 | 入手経緯 | 状態(所持中/使用済み/紛失/譲渡/破損) | メッセージ番号
[/ITEMS]

### Example
[ITEMS]
魔法剣 | 伝説の剣、炎属性攻撃力+10 | {{user}} | ダンジョンで入手 | 所持中 | 42
カップルリング | エリスとの約束の証 | {{user}} | エリスからの贈り物 | 所持中 | 58
[/ITEMS]

- アイテムがなければこのブロックを出力しないでください。`
};

// 이벤트/아이템 블록 제거용 정규식 생성 함수
// 새 마커 형식과 구버전 JSON 형식 모두 지원
export function getEventJsonCleanupPattern() {
    return /\[EVENTS(?:_JSON)?\]\s*[\s\S]*?\s*\[\/.{0,5}EVENTS(?:_JSON)?\]/gi;
}

export function getItemJsonCleanupPattern() {
    return /\[ITEMS(?:_JSON)?\]\s*[\s\S]*?\s*\[\/.{0,5}ITEMS(?:_JSON)?\]/gi;
}

// 아이템 상태 옵션
export const ITEM_STATUS_OPTIONS = {
    'ko': ['보유중', '사용함', '분실', '양도', '파손'],
    'en': ['owned', 'used', 'lost', 'transferred', 'broken'],
    'ja': ['所持中', '使用済み', '紛失', '譲渡', '破損']
};

// 이벤트 중요도 옵션
export const EVENT_IMPORTANCE_OPTIONS = {
    'ko': { high: '높음', medium: '보통', low: '낮음' },
    'en': { high: 'High', medium: 'Medium', low: 'Low' },
    'ja': { high: '高', medium: '中', low: '低' }
};
