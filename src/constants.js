/**
 * 시나리오 자동요약 - 상수 및 기본 설정
 */

// 확장 기본 정보
export const extensionName = "scenario-summarizer";
export const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
export const METADATA_KEY = "scenario_summarizer";
export const DATA_VERSION = 2; // 데이터 구조 버전 (마이그레이션용)

// API 소스 타입
export const API_SOURCE = {
    SILLYTAVERN: "sillytavern",
    CUSTOM: "custom"
};

// 기본 설정값
export const defaultSettings = {
    // 기본 활성화
    enabled: true,
    automaticMode: true,           // 자동 요약 on/off
    
    // 요약 설정
    summaryInterval: 10,           // N개 메세지마다 자동 요약
    batchSize: 10,                 // 한 번에 처리할 메세지 수
    preserveRecentMessages: 5,     // 숨기지 않을 최근 메세지 수
    
    // 요약 모드 설정
    summaryMode: "individual",     // "individual" = 개별 메세지별, "batch" = N개를 하나로 뫆어서
    batchGroupSize: 5,            // batch 모드일 때 몇 개씩 묶어서 요약할지
    
    // 요약 언어 설정
    summaryLanguage: "en",         // "ko" = 한국어, "en" = English, "ja" = 日本語, "hybrid" = 대사 원문 유지
    
    // Auto-Hide 설정
    autoHideEnabled: true,         // 요약된 메세지 자동 숨김
    
    // 등장인물 추적 설정
    characterTrackingEnabled: true, // 요약 시 등장인물 자동 추출/업데이트
    
    // 토큰 예산
    tokenBudget: 20000,            // 주입할 최대 토큰 수
    
    // 요약 컨텍스트 (일관성 유지용)
    summaryContextCount: 5,        // 요약 시 참조할 이전 요약 수 (0 = 사용 안 함, -1 = 전체)
    
    // 요약 카테고리 (각 항목별 활성화 + 커스텀 프롬프트)
    categories: {
        scenario: {
            enabled: true,
            label: "시나리오",
            icon: "📖",
            prompt: "Summarize the cause-and-effect flow of events narratively. Focus on 'who did what and why' rather than simple enumeration. Include important dialogue using double quotes (\"\") with direct quotation from the original text to maintain character voice."
        },
        emotion: {
            enabled: false,
            label: "감정",
            icon: "😊",
            prompt: "Write each line as '- CharacterName: Emotion (cause)'. Separate by character using line breaks. Example: - {{user}}: Bewilderment (due to sudden confession)"
        },
        innerThoughts: {
            enabled: false,
            label: "속마음",
            icon: "💭",
            prompt: "Record ONLY inner monologues or thoughts explicitly shown in the message. Do NOT speculate or fabricate. Write only what is directly expressed in text as '- CharacterName: \"inner thought\"'. If no explicit inner thoughts exist, write 'N/A'."
        },
        atmosphere: {
            enabled: false,
            label: "분위기",
            icon: "🌙",
            prompt: "Briefly describe the scene's overall tension, tone, and mood with adjectives. (e.g., dark and humid, tense, peaceful)"
        },
        location: {
            enabled: true,
            label: "장소",
            icon: "📍",
            prompt: "Briefly specify the physical location where characters are. Use arrow (→) if there was movement. If no movement, write same as previous."
        },
        date: {
            enabled: true,
            label: "날짜",
            icon: "📅",
            prompt: "Infer the date from context (mentions of days, events, seasons, holidays, etc.). Write as 'Month/Day(DayOfWeek)' format (e.g., 12/25(Wed), 1/1(Mon)). If cannot be determined, write 'Unknown' or estimate based on context clues. If same as previous summary, maintain it."
        },
        time: {
            enabled: true,
            label: "시간",
            icon: "⏰",
            prompt: "Specify the time of day (dawn, night, etc.). If no change from previous summary, write same as previous."
        },
        relationship: {
            enabled: true,
            label: "관계",
            icon: "💕",
            prompt: "Define the current relationship between the two characters with a noun that best describes it. (e.g., neighbors, lovers) If a relationship was defined in previous summary, maintain it unless there's a clear change."
        }
    },
    
    // API 설정
    apiSource: API_SOURCE.SILLYTAVERN,
    useRawPrompt: true,            // Raw 프롬프트 사용 (캐릭터 카드 제외)
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
    
    // 프롬프트 프리셋 (종류별)
    promptPresets: [],                    // 개별 요약 프리셋 [{name, template}, ...]
    batchPromptPresets: [],               // 그룹 요약 프리셋
    characterPromptPresets: [],           // 등장인물 추출 프리셋
    selectedPromptPreset: "",             // 개별 요약 선택된 프리셋
    selectedBatchPromptPreset: "",        // 그룹 요약 선택된 프리셋
    selectedCharacterPromptPreset: "",    // 등장인물 추출 선택된 프리셋
    
    // 디버그
    debugMode: false,
    
    // UI 테마
    uiTheme: "mono-gray",         // "mono-gray", "dusty-rose", "ocean-breeze", "matcha-garden"
    
    // 카테고리 순서 (키 배열)
    categoryOrder: ["scenario", "emotion", "innerThoughts", "atmosphere", "location", "date", "time", "relationship"]
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
5. **Continuity:** Only specify time/location/relationship when there are changes.`;

// 묶음 요약 - 사용자 수정 가능 부분 (지침만)
export const DEFAULT_BATCH_PROMPT_TEMPLATE = `You are a skilled writer and editor who weaves extensive roleplay logs into a cohesive narrative flow.

## Mission
Integrate multiple messages (chunks) into a single, naturally flowing narrative summary.

## Writing Principles
1. **Objectivity:** Base your writing on facts presented in the text, not your subjective interpretation.
2. **Contextual Connection:** Instead of simple enumeration, connect events narratively to show cause-and-effect relationships.
3. **Priority Judgment:** Boldly omit trivial greetings or meaningless chatter; focus on actions, events, and dialogue essential to story progression.
4. **Consistency:** End sentences with dry, clear declarative statements (e.g., "~did.").
5. **Continuity:** Only specify time/location/relationship when there are changes.`;

// 등장인물 추출 - 사용자 수정 가능 부분 (지침만)
export const DEFAULT_CHARACTER_PROMPT_TEMPLATE = `Generate profiles for **key characters** who impact the story from the following text.

## Extraction Guidelines
1. **Profile Info Priority:** Always use information already specified in the character profile as-is. Do not infer from message content.
2. **Evidence-Based:** For new characters without profiles, only include what is explicitly stated or strongly implied in the text.
3. **Exclusions:** Exclude characters with no dialogue or background extras who appear briefly.
4. **Format:** Strictly follow the specified JSON format for each character. Write 'N/A' for fields with no information.`;

// 캐릭터 추출 JSON 블록 (요약에 포함될 때 사용) - 언어별 버전
export const CHARACTER_EXTRACTION_BLOCKS = {
    ko: `
## Character Extraction
**Output [CHARACTERS_JSON] for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions) in traits/description
- traits: core personality traits only (up to 10)
- description: physical appearance
- relationshipWithUser: noun format like "이웃", "연인", "직장동료" (short parenthetical note OK)
- **IMPORTANT: If character IS {{user}}, set relationshipWithUser to "본인" (self)**
- **role: Describe the character's narrative role or function in the story (e.g., 주인공, 악역, 조력자, 멘토, 라이벌, 조연, 흑막, etc.)**

[CHARACTERS_JSON]
{
  "캐릭터이름": {
    "role": "스토리에서의 역할 (예: 주인공, 악역, 조력자, 멘토, 라이벌 등)",
    "age": "24",
    "occupation": "대학생",
    "description": "189cm, 근육질 체격",
    "traits": ["외향적", "사교적", "계산적"],
    "relationshipWithUser": "이웃 (같은 오피스텔)"
  }
}
[/CHARACTERS_JSON]

Output {} if characters already fully captured in Existing Characters with no changes.`,

    en: `
## Character Extraction
**Output [CHARACTERS_JSON] for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions) in traits/description
- traits: core personality traits only (up to 10)
- description: physical appearance
- relationshipWithUser: noun format like "neighbor", "lover", "coworker" (short parenthetical note OK)
- **IMPORTANT: If character IS {{user}}, set relationshipWithUser to "self"**
- **role: Describe the character's narrative role or function in the story (e.g., protagonist, antagonist, mentor, ally, rival, supporting, mastermind, etc.)**

[CHARACTERS_JSON]
{
  "CharacterName": {
    "role": "narrative role in story (e.g., protagonist, antagonist, mentor, ally, rival, etc.)",
    "age": "24",
    "occupation": "college student",
    "description": "189cm, muscular build",
    "traits": ["outgoing", "sociable", "calculating"],
    "relationshipWithUser": "neighbor (same officetel)"
  }
}
[/CHARACTERS_JSON]

Output {} if characters already fully captured in Existing Characters with no changes.`,

    ja: `
## Character Extraction
**Output [CHARACTERS_JSON] for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions) in traits/description
- traits: core personality traits only (up to 10)
- description: physical appearance
- relationshipWithUser: noun format like "隣人", "恋人", "同僚" (short parenthetical note OK)
- **IMPORTANT: If character IS {{user}}, set relationshipWithUser to "本人" (self)**
- **role: Describe the character's narrative role or function in the story (e.g., 主人公, 敵役, 助力者, 師匠, ライバル, 脇役, 黒幕, etc.)**

[CHARACTERS_JSON]
{
  "キャラクター名": {
    "role": "物語での役割（例：主人公、敵役、助力者、師匠、ライバルなど）",
    "age": "24",
    "occupation": "大学生",
    "description": "189cm、筋肉質な体格",
    "traits": ["外向的", "社交的", "計算高い"],
    "relationshipWithUser": "隣人（同じマンション）"
  }
}
[/CHARACTERS_JSON]

Output {} if characters already fully captured in Existing Characters with no changes.`,

    zh: `
## Character Extraction
**Output [CHARACTERS_JSON] for characters in this message.**
- First appearance: extract full info
- Already in "Existing Characters": only include if SIGNIFICANT change (relationship change, occupation change, etc.)
- Do NOT include temporary states (drunk, blushing, current emotions) in traits/description
- traits: core personality traits only (up to 10)
- description: physical appearance
- relationshipWithUser: noun format like "邻居", "恋人", "同事" (short parenthetical note OK)
- **IMPORTANT: If character IS {{user}}, set relationshipWithUser to "本人" (self)**
- **role: Describe the character's narrative role or function in the story (e.g., 主角, 反派, 帮手, 导师, 对手, 配角, 幕后黑手, etc.)**

[CHARACTERS_JSON]
{
  "角色名": {
    "role": "故事中的叙事角色（例：主角、反派、帮手、导师、对手等）",
    "age": "24",
    "occupation": "大学生",
    "description": "189cm，肌肉发达的体格",
    "traits": ["外向", "善于交际", "精于算计"],
    "relationshipWithUser": "邻居（同一公寓）"
  }
}
[/CHARACTERS_JSON]

Output {} if characters already fully captured in Existing Characters with no changes.`
};

// 기본값 (하위 호환성)
export const CHARACTER_EXTRACTION_BLOCK = CHARACTER_EXTRACTION_BLOCKS.ko;

/**
 * 캐릭터 JSON 블록 제거용 정규식 생성 함수
 * 글로벌 플래그가 있는 정규식은 상태(lastIndex)를 유지하므로 
 * 매번 새로운 정규식 객체를 생성하여 반환합니다.
 * @returns {RegExp} - [CHARACTERS_JSON]...[/CHARACTERS_JSON] 패턴을 매치하는 정규식 (글로벌, 대소문자 무시)
 */
export function getCharacterJsonCleanupPattern() {
    return /\[CHARACTERS_JSON\]\s*[\s\S]*?\s*\[\/CHARACTERS_JSON\]/gi;
}

// 등장인물 추출 출력 형식 (파싱용)
export const CHARACTER_OUTPUT_FORMAT = `
## Output Format (Required - JSON only)
{
  "characters": {
    "CharacterName": {
      "role": "Role description",
      "age": "Age (e.g., 24, early 20s)",
      "occupation": "Occupation (N/A if unknown)",
      "description": "Appearance/characteristics",
      "traits": ["trait1", "trait2"],
      "relationshipWithUser": "Relationship with {{user}} (N/A if unknown)",
      "firstMessageNum": First appearance message number
    }
  }
}`;
