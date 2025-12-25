/**
 * 시나리오 자동요약 - 요약 생성 핵심 로직
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { power_user } from "../../../../power-user.js";
import { 
    extensionName, 
    DEFAULT_PROMPT_TEMPLATE, 
    DEFAULT_BATCH_PROMPT_TEMPLATE,
    CHARACTER_EXTRACTION_BLOCKS,
    CHARACTER_OUTPUT_FORMAT,
    getCharacterJsonCleanupPattern
} from './constants.js';
import { log, getSettings, startSummarizing, stopSummarizing, shouldStop, isSummarizing, logError } from './state.js';
import { getSummaryData, saveSummaryData, setSummaryForMessage, formatCharactersText, mergeExtractedCharacters, getPreviousContext, getRecentSummariesForContext } from './storage.js';
import { callSummaryAPI } from './api.js';
import { applyMessageVisibility } from './visibility.js';
import { injectSummaryToPrompt } from './injection.js';

// ===== 사전 컴파일된 정규식 =====
const REGEX_PREV_TIME = /\{\{PREV_TIME\}\}/g;
const REGEX_PREV_LOCATION = /\{\{PREV_LOCATION\}\}/g;
const REGEX_PREV_RELATIONSHIP = /\{\{PREV_RELATIONSHIP\}\}/g;
const REGEX_CHARACTERS_JSON = /\[CHARACTERS_JSON\]\s*([\s\S]*?)\s*\[\/CHARACTERS_JSON\]/gi;
const REGEX_GROUP_HEADER = /^#\d+-\d+\s*\n?/;

/**
 * SillyTavern에서 프로필 정보 가져오기 (캐릭터 카드, 페르소나, 월드인포)
 * 요약 시 캐릭터와 유저의 컨텍스트 정보를 제공
 * @returns {string} - 프로필 정보 텍스트
 */
function getProfileInfo() {
    const context = getContext();
    if (!context) return '';
    
    // Profile info (character card, user persona, world info) is always included as context for summarization
    
    let profileText = '';
    
    // 1. Character Card Info (from context.characters for current character)
    try {
        // Get current character info from characterData or characters
        let charData = null;
        if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
            charData = context.characters[context.characterId];
        } else if (context.characterData) {
            charData = context.characterData;
        }
        
        if (charData) {
            profileText += '## Character Card Info\n';
            if (charData.name) profileText += `* Name: ${charData.name}\n`;
            if (charData.description) profileText += `* Description: ${charData.description}\n`;
            if (charData.personality) profileText += `* Personality: ${charData.personality}\n`;
            if (charData.scenario) profileText += `* Scenario: ${charData.scenario}\n`;
            // Greeting (first_mes) and example dialogue (mes_example) are excluded as unnecessary for summarization
            profileText += '\n';
        }
    } catch (e) {
        log(`Failed to get character data: ${e.message}`);
    }
    
    // 2. Persona Info (User Persona) - from power_user
    try {
        const userName = context.name1 || '';
        // Get current persona description from power_user.persona_description
        const userPersona = power_user?.persona_description || '';
        
        if (userName || userPersona) {
            profileText += '## Persona Info (User)\n';
            if (userName) profileText += `* Name: ${userName}\n`;
            if (userPersona) profileText += `* Description: ${userPersona}\n`;
            profileText += '\n';
        }
    } catch (e) {
        log(`Failed to get persona data: ${e.message}`);
    }
    
    // 3. World Info / Lorebook
    // Property names may vary by SillyTavern API version (worldInfo/world_info, content/entry, keys/key)
    try {
        const worldInfo = context.worldInfo || context.world_info || [];
        
        if (worldInfo && worldInfo.length > 0) {
            profileText += '## World Info / Lorebook\n';
            for (const entry of worldInfo) {
                if (entry && (entry.content || entry.entry)) {
                    const entryContent = entry.content || entry.entry || '';
                    const entryKeys = entry.keys || entry.key || [];
                    const keyStr = Array.isArray(entryKeys) ? entryKeys.join(', ') : entryKeys;
                    if (keyStr) {
                        profileText += `### ${keyStr}\n${entryContent}\n\n`;
                    } else {
                        profileText += `${entryContent}\n\n`;
                    }
                }
            }
        }
    } catch (e) {
        log(`Failed to get world info: ${e.message}`);
    }
    
    return profileText.trim();
}

/**
 * 개별 요약 프롬프트 생성 (batchSize 만큼 묶어서 개별 요약)
 * @param {Array} messages - 요약할 메시지 배열
 * @param {number} startIndex - 시작 인덱스
 * @returns {string}
 */
export function buildSummaryPrompt(messages, startIndex) {
    const settings = getSettings();
    const cats = settings.categories || {};
    const language = settings.summaryLanguage || 'ko';
    
    // 언어 설정 - 매우 강력한 지시
    const langInstructions = {
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
    
    // 메시지 포맷팅 (0-indexed)
    const formattedMessages = messages.map((msg, idx) => {
        const speaker = msg.name || (msg.is_user ? "User" : "Character");
        const msgNum = startIndex + idx;
        return `[#${msgNum}] ${speaker}: ${msg.mes}`;
    }).join("\n\n");
    
    // 카테고리별 출력 형식 (순서 적용)
    const categoryFormat = buildCategoryFormat(cats, settings.categoryOrder);
    
    // 기존 등장인물 컨텍스트 (토글 활성화 시)
    const existingChars = settings.characterTrackingEnabled !== false ? formatCharactersText(true) : '';
    
    // 캐릭터 추출 블록 (토글 활성화 시, 언어별)
    const charExtractionLang = language === 'hybrid' ? 'en' : language;
    const characterExtraction = settings.characterTrackingEnabled !== false 
        ? (CHARACTER_EXTRACTION_BLOCKS[charExtractionLang] || CHARACTER_EXTRACTION_BLOCKS.ko)
        : '';
    
    // 사용자 커스텀 프롬프트 또는 기본 프롬프트 (지침만)
    let userInstructions = settings.customPromptTemplate || DEFAULT_PROMPT_TEMPLATE;
    
    // 컨텍스트 체인: 이전 요약에서 시간/장소/관계 가져오기 (사전 컴파일된 정규식 사용)
    const prevContext = getPreviousContext(startIndex);
    userInstructions = userInstructions
        .replace(REGEX_PREV_TIME, prevContext.time)
        .replace(REGEX_PREV_LOCATION, prevContext.location)
        .replace(REGEX_PREV_RELATIONSHIP, prevContext.relationship);
    
    // 글로벌 정규식 lastIndex 리셋
    REGEX_PREV_TIME.lastIndex = 0;
    REGEX_PREV_LOCATION.lastIndex = 0;
    REGEX_PREV_RELATIONSHIP.lastIndex = 0;
    
    // 언어 지시
    const langInstruction = langInstructions[language] || langInstructions['ko'];
    
    // 이전 컨텍스트 정보 추가 (프롬프트에 직접 전달 - 최소 정보, 항상 포함)
    const contextInfo = `
## Previous Summary State (for continuity)
* Previous Time: ${prevContext.time}
* Previous Location: ${prevContext.location}
* Previous Relationship: ${prevContext.relationship}
`;
    
    // 이전 요약 참조 (일관성 유지용, summaryContextCount 설정에 따라)
    const summaryContextCount = settings.summaryContextCount !== undefined ? settings.summaryContextCount : 5;
    const recentSummaries = getRecentSummariesForContext(startIndex, summaryContextCount);
    const recentSummariesSection = recentSummaries ? `
## Recent Summaries (for consistency reference)
${recentSummaries}
` : '';
    
    // 프로필 정보 가져오기 (캐릭터 카드/페르소나/월드인포)
    const profileInfo = getProfileInfo();
    const profileSection = profileInfo ? `
## Reference Info (Character Card/Persona/World Info)
${profileInfo}
` : '';
    
    // 언어별 추가 리마인더 (출력 형식 앞에 추가) - 매우 강력
    const langReminders = {
        'ko': '\n🚨 **[최종 리마인더] 아래 출력을 반드시 한국어로 작성하세요!** 🚨\n',
        'en': '\n🚨 **[FINAL REMINDER] Write ALL output below in ENGLISH! Translate all dialogue!** 🚨\n',
        'ja': '\n🚨 **【最終リマインダー】以下の出力はすべて日本語で！** 🚨\n',
        'hybrid': '\n🚨 **[FINAL REMINDER - HYBRID MODE]** 🚨\n**Narrative = ENGLISH | Dialogue in quotes = ORIGINAL LANGUAGE (한국어/日本語/etc.)**\nDO NOT translate the dialogue! Keep "quoted text" exactly as in source!\n'
    };
    const langReminder = langReminders[language] || langReminders['ko'];
    
    // 최종 프롬프트 조립: 언어 + 지침 + 프로필정보 + 이전컨텍스트 + 이전요약 + 기존캐릭터 + 메시지 + 출력형식
    const prompt = `${langInstruction}

${userInstructions}
${profileSection}${contextInfo}${recentSummariesSection}
${existingChars}
## Messages to Summarize
${formattedMessages}
${langReminder}
## Output Format (Required - for each message)
#MessageNumber
${categoryFormat || '* Scenario: (Integrate key events and dialogue narratively)'}
${characterExtraction}`;
    
    return prompt;
}

/**
 * 카테고리 형식 문자열 생성
 * @param {Object} cats - 카테고리 객체
 * @param {Array} categoryOrder - 카테고리 순서 배열 (옵션)
 */
function buildCategoryFormat(cats, categoryOrder) {
    let categoryFormat = "";
    
    // 순서대로 카테고리 처리 (categoryOrder가 있으면 그 순서로, 없으면 기본 순서)
    const allKeys = Object.keys(cats);
    const allKeysSet = new Set(allKeys);
    let orderedKeys;
    
    if (categoryOrder && Array.isArray(categoryOrder) && categoryOrder.length > 0) {
        // categoryOrder에 있는 유효한 키들을 순서대로 가져옴
        orderedKeys = categoryOrder.filter(key => allKeysSet.has(key));
        // categoryOrder에 없는 새 키들 추가
        const orderedSet = new Set(orderedKeys);
        const newKeys = allKeys.filter(key => !orderedSet.has(key));
        orderedKeys = [...orderedKeys, ...newKeys];
    } else {
        orderedKeys = allKeys;
    }
    
    // 순서대로 카테고리 처리
    for (const key of orderedKeys) {
        const value = cats[key];
        
        // 객체 형태인 경우 (새 구조)
        if (typeof value === 'object' && value !== null) {
            if (value.enabled) {
                const label = value.label || key;
                const prompt = value.prompt || '';
                categoryFormat += `* ${label}: (${prompt})\n`;
            }
        } 
        // 불리언 형태인 경우 (구 구조 - 마이그레이션 호환)
        else if (value === true) {
            const defaultPrompts = {
                scenario: 'Integrate key events and character dialogue/actions narratively',
                emotion: 'Emotional state/changes per character',
                innerThoughts: 'Inner thoughts explicitly shown in text only',
                atmosphere: 'Scene tone and mood',
                location: 'Current location/setting',
                time: 'Time of day',
                relationship: 'Relationship changes between characters'
            };
            const label = key === 'scenario' ? 'Scenario' : 
                          key === 'emotion' ? 'Emotion' :
                          key === 'innerThoughts' ? 'Inner Thoughts' :
                          key === 'atmosphere' ? 'Atmosphere' :
                          key === 'location' ? 'Location' :
                          key === 'time' ? 'Time' :
                          key === 'relationship' ? 'Relationship' : key;
            categoryFormat += `* ${label}: (${defaultPrompts[key] || ''})\n`;
        }
    }
    
    // 빈 경우 기본값
    if (!categoryFormat) {
        categoryFormat = '* Scenario: (Integrate key events and dialogue narratively)\n';
    }
    
    return categoryFormat;
}

/**
 * 묶음(배치) 요약 프롬프트 생성
 * @param {Array} groups - [{indices: [0,1,2], messages: [msg,msg,msg]}, ...]
 * @param {Object} settings - 확장 설정
 * @returns {string}
 */
export function buildBatchGroupsPrompt(groups, settings) {
    const cats = settings.categories || {};
    const language = settings.summaryLanguage || 'ko';
    
    // 언어 설정 - 매우 강력한 지시
    const langInstructions = {
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
    
    // 카테고리별 출력 형식 (순서 적용)
    const categoryFormat = buildCategoryFormat(cats, settings.categoryOrder);
    
    // 그룹별 메시지 포맷팅
    let groupsText = "";
    const groupRanges = [];
    let startIndex = groups.length > 0 ? groups[0].indices[0] : 0;
    
    for (const group of groups) {
        const startNum = group.indices[0];
        const endNum = group.indices[group.indices.length - 1];
        groupRanges.push(`#${startNum}-${endNum}`);
        
        groupsText += `\n=== 묶음 #${startNum}-${endNum} ===\n`;
        for (let i = 0; i < group.messages.length; i++) {
            const msg = group.messages[i];
            const msgNum = group.indices[i];
            const speaker = msg.name || (msg.is_user ? "User" : "Character");
            groupsText += `[#${msgNum}] ${speaker}: ${msg.mes}\n\n`;
        }
    }
    
    // 기존 등장인물 컨텍스트
    const existingChars = settings.characterTrackingEnabled !== false ? formatCharactersText(true) : '';
    
    // 캐릭터 추출 블록 (토글 활성화 시, 언어별)
    const charExtractionLang = language === 'hybrid' ? 'en' : language;
    const characterExtraction = settings.characterTrackingEnabled !== false 
        ? (CHARACTER_EXTRACTION_BLOCKS[charExtractionLang] || CHARACTER_EXTRACTION_BLOCKS.ko)
        : '';
    
    // 사용자 커스텀 프롬프트 또는 기본 프롬프트 (지침만)
    let userInstructions = settings.customBatchPromptTemplate || DEFAULT_BATCH_PROMPT_TEMPLATE;
    
    // 컨텍스트 체인: 이전 요약에서 시간/장소/관계 가져오기 (사전 컴파일된 정규식 사용)
    const prevContext = getPreviousContext(startIndex);
    userInstructions = userInstructions
        .replace(REGEX_PREV_TIME, prevContext.time)
        .replace(REGEX_PREV_LOCATION, prevContext.location)
        .replace(REGEX_PREV_RELATIONSHIP, prevContext.relationship);
    
    // 글로벌 정규식 lastIndex 리셋
    REGEX_PREV_TIME.lastIndex = 0;
    REGEX_PREV_LOCATION.lastIndex = 0;
    REGEX_PREV_RELATIONSHIP.lastIndex = 0;
    
    // 언어 지시
    const langInstruction = langInstructions[language] || langInstructions['ko'];
    
    // 이전 컨텍스트 정보 추가 (프롬프트에 직접 전달 - 최소 정보, 항상 포함)
    const contextInfo = `
## Previous Summary State (for continuity)
* Previous Time: ${prevContext.time}
* Previous Location: ${prevContext.location}
* Previous Relationship: ${prevContext.relationship}
`;
    
    // 이전 요약 참조 (일관성 유지용, summaryContextCount 설정에 따라)
    const summaryContextCount = settings.summaryContextCount !== undefined ? settings.summaryContextCount : 5;
    const recentSummaries = getRecentSummariesForContext(startIndex, summaryContextCount);
    const recentSummariesSection = recentSummaries ? `
## Recent Summaries (for consistency reference)
${recentSummaries}
` : '';
    
    // 그룹 범위 출력 형식
    const outputFormatExample = categoryFormat || '* Scenario: (Integrate key events and dialogue narratively)';
    
    // 프로필 정보 가져오기 (캐릭터 카드/페르소나/월드인포)
    const profileInfo = getProfileInfo();
    const profileSection = profileInfo ? `
## Reference Info (Character Card/Persona/World Info)
${profileInfo}
` : '';
    
    // 언어별 추가 리마인더 (출력 형식 앞에 추가) - 매우 강력
    const langReminders = {
        'ko': '\n🚨 **[최종 리마인더] 아래 출력을 반드시 한국어로 작성하세요!** 🚨\n',
        'en': '\n🚨 **[FINAL REMINDER] Write ALL output below in ENGLISH! Translate all dialogue!** 🚨\n',
        'ja': '\n🚨 **【最終リマインダー】以下の出力はすべて日本語で！** 🚨\n',
        'hybrid': '\n🚨 **[FINAL REMINDER - HYBRID MODE]** 🚨\n**Narrative = ENGLISH | Dialogue in quotes = ORIGINAL LANGUAGE (한국어/日本語/etc.)**\nDO NOT translate the dialogue! Keep "quoted text" exactly as in source!\n'
    };
    const langReminder = langReminders[language] || langReminders['ko'];
    
    // 최종 프롬프트 조립: 언어 + 지침 + 프로필정보 + 이전컨텍스트 + 이전요약 + 등장인물 + 메시지 + 출력형식
    const prompt = `${langInstruction}

${userInstructions}
${profileSection}${contextInfo}${recentSummariesSection}
## Existing Characters
${existingChars || '(None)'}

## Messages to Summarize
${groupsText}
${langReminder}
## Output Format (Required - for each batch)
#StartNumber-EndNumber
${outputFormatExample}
${characterExtraction}`;
    
    return prompt;
}

/**
 * AI 응답에서 캐릭터 JSON 추출 및 저장
 * @param {string} response - API 응답
 * @param {number} messageIndex - 첫 등장으로 기록할 메시지 인덱스
 * @returns {string} - 캐릭터 JSON 부분이 제거된 응답
 */
function extractAndSaveCharacters(response, messageIndex) {
    const settings = getSettings();
    if (settings.characterTrackingEnabled === false) {
        log(`Character tracking disabled, skipping extraction`);
        return response;
    }
    
    // [CHARACTERS_JSON] 블록이 있는지 먼저 확인
    const hasCharBlock = response.includes('[CHARACTERS_JSON]');
    log(`Character extraction: hasCharBlock=${hasCharBlock}, responseLength=${response.length}`);
    
    if (!hasCharBlock) {
        log(`No [CHARACTERS_JSON] block found in response`);
        return response;
    }
    
    // 사전 컴파일된 정규식 사용 (글로벌 플래그)
    REGEX_CHARACTERS_JSON.lastIndex = 0; // 리셋
    let match;
    let extractedCount = 0;
    
    // 모든 캐릭터 JSON 블록에서 캐릭터 추출
    while ((match = REGEX_CHARACTERS_JSON.exec(response)) !== null) {
        if (match[1]) {
            try {
                const jsonStr = match[1].trim();
                log(`Found character JSON block: ${jsonStr.substring(0, 100)}...`);
                if (jsonStr && jsonStr !== '{}') {
                    const characters = JSON.parse(jsonStr);
                    if (Object.keys(characters).length > 0) {
                        log(`Parsed ${Object.keys(characters).length} characters: ${Object.keys(characters).join(', ')}`);
                        mergeExtractedCharacters(characters, messageIndex);
                        extractedCount += Object.keys(characters).length;
                    }
                } else {
                    log(`Empty character JSON block`);
                }
            } catch (e) {
                log(`Failed to parse character JSON: ${e.message}, content: ${match[1].substring(0, 200)}`);
            }
        }
    }
    
    if (extractedCount > 0) {
        log(`Extracted ${extractedCount} characters from response`);
    } else {
        log(`No characters extracted from response`);
    }
    
    // 모든 캐릭터 JSON 부분 제거하여 반환 (글로벌 플래그로 모든 매치 제거)
    const cleanedResponse = response.replace(getCharacterJsonCleanupPattern(), '').trim();
    
    return cleanedResponse;
}

/**
 * 여러 그룹 응답 파싱
 * @param {string} response - API 응답
 * @param {Array} groups - 그룹 배열
 * @returns {Object} - { 인덱스: 요약내용 }
 */
export function parseBatchGroupsResponse(response, groups) {
    // 먼저 캐릭터 추출 및 저장
    const firstIndex = groups.length > 0 ? groups[0].indices[0] : 0;
    const cleanResponse = extractAndSaveCharacters(response, firstIndex);
    const result = {};
    
    log(`Parsing batch groups response (${cleanResponse.length} chars), ${groups.length} groups expected`);
    
    // 각 그룹에 대해 패턴 매칭
    for (const group of groups) {
        const startNum = group.indices[0];
        const endNum = group.indices[group.indices.length - 1];
        
        // #시작-끝 패턴 찾기
        const patterns = [
            new RegExp(`#${startNum}-${endNum}\\s*\\n([\\s\\S]*?)(?=#\\d+-\\d+|===|$)`, 'g'),
            new RegExp(`#${startNum}\\s*[-~]\\s*${endNum}\\s*\\n([\\s\\S]*?)(?=#\\d+|===|$)`, 'g'),
            new RegExp(`\\[#${startNum}-${endNum}\\]\\s*\\n?([\\s\\S]*?)(?=\\[#\\d+|===|$)`, 'g')
        ];
        
        let matched = false;
        for (const pattern of patterns) {
            const match = pattern.exec(cleanResponse);
            if (match && match[1].trim()) {
                const summary = match[1].trim();
                // 첫 번째 인덱스에 전체 그룹 요약 저장
                result[group.indices[0]] = `#${startNum}-${endNum}\n${summary}`;
                // 나머지 인덱스는 그룹에 포함됨 표시
                for (let i = 1; i < group.indices.length; i++) {
                    result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
                }
                matched = true;
                break;
            }
            pattern.lastIndex = 0; // 리셋
        }
        
        // 매칭 실패 시, 플레이스홀더 저장 (요약은 실패했지만 처리됨으로 마킹)
        if (!matched) {
            log(`Pattern match failed for group #${startNum}-${endNum}, saving placeholder`);
            // 첫 번째 인덱스에 파싱 실패 표시와 함께 저장
            result[group.indices[0]] = `#${startNum}-${endNum}\n[요약 파싱 실패 - 재요약 필요]`;
            // 나머지 인덱스는 그룹에 포함됨 표시
            for (let i = 1; i < group.indices.length; i++) {
                result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
            }
        }
    }
    
    // 결과가 없으면 전체 응답을 첫 그룹에 할당
    if (Object.keys(result).length === 0 && groups.length > 0) {
        log(`All pattern matching failed, assigning whole response to first group`);
        const firstGroup = groups[0];
        const startNum = firstGroup.indices[0];
        const endNum = firstGroup.indices[firstGroup.indices.length - 1];
        
        result[firstGroup.indices[0]] = `#${startNum}-${endNum}\n${cleanResponse.trim()}`;
        for (let i = 1; i < firstGroup.indices.length; i++) {
            result[firstGroup.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
        }
    }
    
    log(`Parsed ${Object.keys(result).length} summaries from batch groups response`);
    return result;
}

/**
 * API 응답을 개별 메시지별로 파싱
 * @param {string} response - API 응답
 * @param {number} startIndex - 시작 인덱스
 * @param {number} endIndex - 끝 인덱스
 * @returns {Object} - { 인덱스: 요약내용 }
 */
export function parseApiResponse(response, startIndex, endIndex) {
    // 먼저 캐릭터 추출 및 저장
    const cleanResponse = extractAndSaveCharacters(response, startIndex);
    const result = {};
    
    log(`Parsing response (${cleanResponse.length} chars), startIndex=${startIndex}, endIndex=${endIndex}`);
    
    // 개별 모드: 여러 패턴 시도
    // 패턴 1: #숫자\n내용 (기본) - 이제 0-indexed
    let pattern = /#(\d+)\s*\n([\s\S]*?)(?=#\d+\s*\n|$)/g;
    let match;
    
    while ((match = pattern.exec(cleanResponse)) !== null) {
        const msgNum = parseInt(match[1]);
        const summary = match[2].trim();
        const index = msgNum; // 이제 번호 = 인덱스 (0-indexed)
        
        if (index >= startIndex && index <= endIndex && summary) {
            result[index] = `#${msgNum}\n${summary}`;
        }
    }
    
    // 패턴 1 실패 시, 패턴 2 시도: [#숫자] 또는 【#숫자】 형식
    if (Object.keys(result).length === 0) {
        pattern = /[\[【]#?(\d+)[\]】]\s*\n?([\s\S]*?)(?=[\[【]#?\d+[\]】]|$)/g;
        
        while ((match = pattern.exec(cleanResponse)) !== null) {
            const msgNum = parseInt(match[1]);
            const summary = match[2].trim();
            const index = msgNum; // 0-indexed
            
            if (index >= startIndex && index <= endIndex && summary) {
                result[index] = `#${msgNum}\n${summary}`;
            }
        }
    }
    
    // 패턴 2도 실패 시, 패턴 3 시도: **#숫자** 또는 ## #숫자 마크다운 형식
    if (Object.keys(result).length === 0) {
        pattern = /(?:\*\*#?|##\s*#?)(\d+)(?:\*\*)?[:\s]*\n?([\s\S]*?)(?=(?:\*\*#?|##\s*#?)\d+|$)/g;
        
        while ((match = pattern.exec(cleanResponse)) !== null) {
            const msgNum = parseInt(match[1]);
            const summary = match[2].trim();
            const index = msgNum; // 0-indexed
            
            if (index >= startIndex && index <= endIndex && summary) {
                result[index] = `#${msgNum}\n${summary}`;
            }
        }
    }
    
    // 모든 패턴 실패 시
    if (Object.keys(result).length === 0) {
        log(`Failed to parse API response. First 500 chars: ${cleanResponse.substring(0, 500)}`);
        // 전체 응답을 첫 번째 메시지에 임시 할당
        if (response.trim()) {
            result[startIndex] = response.trim();
        }
    } else {
        log(`Successfully parsed ${Object.keys(result).length} summaries`);
    }
    
    return result;
}

/**
 * 요약 실행 (메인 함수)
 * @param {number|null} customStart - 커스텀 시작 인덱스
 * @param {number|null} customEnd - 커스텀 끝 인덱스
 * @param {Function} onProgress - 진행 콜백 (current, total)
 * @returns {Promise<{success: boolean, processed: number, error?: string}>}
 */
export async function runSummary(customStart = null, customEnd = null, onProgress = null) {
    if (isSummarizing()) {
        return { success: false, processed: 0, error: "이미 요약 중입니다" };
    }
    
    const context = getContext();
    if (!context.chat || context.chat.length === 0) {
        return { success: false, processed: 0, error: "채팅이 없습니다" };
    }
    
    const settings = getSettings();
    const data = getSummaryData();
    if (!data) {
        return { success: false, processed: 0, error: "데이터 접근 실패" };
    }
    
    startSummarizing();
    
    try {
        const totalMessages = context.chat.length;
        const isBatchMode = settings.summaryMode === 'batch';
        // batchSize = API 호출 당 처리할 메시지 수
        // batchGroupSize = 배치 모드에서 몇 개씩 그룹핑할지 (하나의 API 호출 내에서)
        const messagesPerApiCall = settings.batchSize || 10;
        const groupSize = settings.batchGroupSize || 10;
        
        // 시작/끝 인덱스 결정
        let startIndex, endIndex;
        if (customStart !== null && customEnd !== null) {
            startIndex = customStart;
            endIndex = Math.min(customEnd, totalMessages - 1);
        } else {
            // 요약 안 된 메시지부터 시작
            startIndex = findFirstUnsummarizedIndex(data, context.chat);
            endIndex = totalMessages - 1;
        }
        
        if (startIndex > endIndex || startIndex >= totalMessages) {
            stopSummarizing();
            return { success: true, processed: 0, error: "요약할 메시지가 없습니다" };
        }
        
        log(`Summarizing messages ${startIndex + 1} to ${endIndex + 1} (mode: ${isBatchMode ? 'batch' : 'individual'})`);
        
        let processedCount = 0;
        let currentStart = startIndex;
        
        while (currentStart <= endIndex && !shouldStop()) {
            // API 호출 당 messagesPerApiCall 만큼 처리
            const currentEnd = Math.min(currentStart + messagesPerApiCall - 1, endIndex);
            
            // 숨겨진 메시지 필터링 (유저가 숨긴 메시지 제외)
            const messagesToSummarize = [];
            const indicesToProcess = [];
            
            for (let i = currentStart; i <= currentEnd; i++) {
                const msg = context.chat[i];
                // 유저가 숨긴 메시지가 아니면 요약 대상
                if (!msg._userHidden && !isUserHiddenMessage(msg, i)) {
                    messagesToSummarize.push(msg);
                    indicesToProcess.push(i);
                }
            }
            
            if (messagesToSummarize.length > 0) {
                // 진행 콜백
                if (onProgress) {
                    onProgress(currentEnd - startIndex + 1, endIndex - startIndex + 1);
                }
                
                // 배치 모드에서만 그룹으로 처리, 개별 모드는 항상 개별 처리
                if (isBatchMode) {
                    // 그룹들 생성: 하나의 API 호출에서 여러 그룹 요약 생성
                    const groups = [];
                    
                    // 배치 모드: groupSize로 나눔
                    for (let i = 0; i < indicesToProcess.length; i += groupSize) {
                        const groupIndices = indicesToProcess.slice(i, Math.min(i + groupSize, indicesToProcess.length));
                        const groupMessages = messagesToSummarize.slice(i, Math.min(i + groupSize, messagesToSummarize.length));
                        groups.push({ indices: groupIndices, messages: groupMessages });
                    }
                    
                    // 여러 그룹을 위한 프롬프트 생성
                    const prompt = buildBatchGroupsPrompt(groups, settings);
                    const response = await callSummaryAPI(prompt);
                    
                    if (shouldStop()) break;
                    
                    if (response) {
                        const parsed = parseBatchGroupsResponse(response, groups);
                        
                        for (const [index, content] of Object.entries(parsed)) {
                            setSummaryForMessage(parseInt(index), content);
                            processedCount++;
                        }
                        
                        await saveSummaryData();
                    }
                } else {
                    // 개별 모드: 기존 로직
                    const prompt = buildSummaryPrompt(messagesToSummarize, indicesToProcess[0]);
                    const response = await callSummaryAPI(prompt);
                    
                    if (shouldStop()) break;
                    
                    if (response) {
                        const parsed = parseApiResponse(response, indicesToProcess[0], indicesToProcess[indicesToProcess.length - 1]);
                        
                        for (const [index, content] of Object.entries(parsed)) {
                            setSummaryForMessage(parseInt(index), content);
                            processedCount++;
                        }
                        
                        await saveSummaryData();
                    }
                }
            }
            
            currentStart = currentEnd + 1;
        }
        
        // 완료 후 처리
        applyMessageVisibility();
        injectSummaryToPrompt();
        
        stopSummarizing();
        
        if (shouldStop()) {
            return { success: false, processed: processedCount, error: "중단됨" };
        }
        
        return { success: true, processed: processedCount };
        
    } catch (error) {
        stopSummarizing();
        log(`Summary error: ${error.message}`);
        logError('runSummary', error, { startIndex, endIndex, batchSize });
        return { success: false, processed: 0, error: error.message };
    }
}

/**
 * 자동 요약 실행 (이벤트에서 호출)
 * @returns {Promise<boolean>}
 */
export async function runAutoSummary() {
    const settings = getSettings();
    
    log(`Auto-summary check: enabled=${settings.enabled}, automaticMode=${settings.automaticMode}`);
    
    if (!settings.enabled || !settings.automaticMode) {
        log('Auto-summary skipped: disabled or manual mode');
        return false;
    }
    
    const context = getContext();
    const data = getSummaryData();
    
    if (!context.chat || !data) {
        log(`Auto-summary skipped: no chat or data (chat=${!!context.chat}, data=${!!data})`);
        return false;
    }
    
    // 요약 안 된 메시지 수 확인
    const unsummarizedCount = countUnsummarizedMessages(data, context.chat);
    const interval = settings.summaryInterval || 10;
    const groupSize = settings.batchGroupSize || 10;
    
    log(`Auto-summary: ${unsummarizedCount} unsummarized messages, interval=${interval}, groupSize=${groupSize}`);
    
    if (unsummarizedCount >= interval) {
        log(`Auto-summary triggered: ${unsummarizedCount} >= ${interval}`);
        
        // 그룹 크기의 배수만큼만 요약하도록 제한 (남은 메시지는 다음에 처리)
        // 이렇게 하면 #5~5 같은 단일 메시지 요약이 방지됨
        const messagesToProcess = Math.floor(unsummarizedCount / groupSize) * groupSize;
        
        if (messagesToProcess < groupSize) {
            // 그룹 크기 미만이면 대기 (interval은 넘었지만 그룹을 못 채움)
            log(`Auto-summary deferred: ${unsummarizedCount} messages but need at least ${groupSize} for a full group`);
            return false;
        }
        
        // 첫 번째 미요약 인덱스 찾기
        const startIndex = findFirstUnsummarizedIndex(data, context.chat);
        const endIndex = startIndex + messagesToProcess - 1;
        
        log(`Auto-summary processing: indices ${startIndex} to ${endIndex} (${messagesToProcess} messages)`);
        
        const result = await runSummary(startIndex, endIndex);
        return result.success;
    }
    
    log(`Auto-summary not triggered: ${unsummarizedCount} < ${interval}`);
    return false;
}

/**
 * 첫 번째 요약 안 된 메시지 인덱스 찾기
 * @param {Object} data 
 * @param {Array} chat 
 * @returns {number}
 */
function findFirstUnsummarizedIndex(data, chat) {
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        // 유저가 숨긴 메시지가 아니고, 요약이 없으면
        if (!msg._userHidden && !isUserHiddenMessage(msg, i) && !data.summaries[i]) {
            return i;
        }
    }
    return chat.length; // 모두 요약됨
}

/**
 * 요약 안 된 메시지 수 세기
 * @param {Object} data 
 * @param {Array} chat 
 * @returns {number}
 */
function countUnsummarizedMessages(data, chat) {
    let count = 0;
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg._userHidden && !isUserHiddenMessage(msg, i) && !data.summaries[i]) {
            count++;
        }
    }
    return count;
}

/**
 * 유저가 숨긴 메시지인지 확인
 * (요약으로 숨긴 게 아니라 유저가 직접 숨긴 경우)
 * @param {Object} msg 
 * @param {number} index 
 * @returns {boolean}
 */
function isUserHiddenMessage(msg, index) {
    // _userHidden 플래그가 있으면 유저가 숨긴 것
    if (msg._userHidden) return true;
    
    // is_system이 true이고, 우리 확장이 숨긴 게 아니면 유저가 숨긴 것
    // (우리가 숨긴 건 _summarizedHidden 플래그로 구분)
    if (msg.is_system && !msg._summarizedHidden) {
        return true;
    }
    
    return false;
}

/**
 * 단일 메시지 또는 그룹 재요약
 * @param {number} messageIndex 
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function resummarizeMessage(messageIndex) {
    const context = getContext();
    const settings = getSettings();
    const data = getSummaryData();
    
    if (!context.chat || messageIndex >= context.chat.length) {
        return { success: false, error: "잘못된 메시지 인덱스" };
    }
    
    // 현재 요약 내용 확인 - 그룹 요약인지 체크
    const summaryObj = data?.summaries?.[messageIndex];
    const currentSummary = summaryObj?.content || "";
    
    log(`Resummarize: messageIndex=${messageIndex}, currentSummary starts with: ${currentSummary.substring(0, 50)}`);
    
    // 그룹 요약 패턴 체크: #X-Y 형식
    const groupPattern = /^#(\d+)-(\d+)/;
    const groupMatch = groupPattern.exec(currentSummary);
    
    // 그룹에 포함됨 표시 체크: [→ #X-Y 그룹 요약에 포함]
    const includedPattern = /\[→ #(\d+)-(\d+) 그룹 요약에 포함\]/;
    const includedMatch = includedPattern.exec(currentSummary);
    
    let startIdx, endIdx;
    
    if (groupMatch) {
        // 이 메시지가 그룹 요약의 시작점
        startIdx = parseInt(groupMatch[1]) - 1; // 0-based
        endIdx = parseInt(groupMatch[2]) - 1;
    } else if (includedMatch) {
        // 이 메시지가 다른 그룹에 포함됨
        startIdx = parseInt(includedMatch[1]) - 1;
        endIdx = parseInt(includedMatch[2]) - 1;
    } else {
        // 개별 요약 - 단일 메시지만 재생성
        startIdx = messageIndex;
        endIdx = messageIndex;
    }
    
    // 범위 검증
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(endIdx, context.chat.length - 1);
    
    try {
        // 메시지들 수집
        const messages = [];
        const indices = [];
        for (let i = startIdx; i <= endIdx; i++) {
            messages.push(context.chat[i]);
            indices.push(i);
        }
        
        // 그룹 모드인지 확인 (2개 이상 메시지면 그룹)
        const isGroupMode = messages.length > 1;
        
        let response;
        if (isGroupMode) {
            // 그룹 요약: buildBatchGroupsPrompt 사용
            const groups = [{ indices, messages }];
            const prompt = buildBatchGroupsPrompt(groups, settings);
            response = await callSummaryAPI(prompt);
        } else {
            // 개별 요약: buildSummaryPrompt 사용
            const prompt = buildSummaryPrompt(messages, startIdx);
            response = await callSummaryAPI(prompt);
        }
        
        if (response) {
            if (isGroupMode) {
                // 캐릭터 JSON 추출 및 제거 (빈 {}도 제거됨)
                const cleanedResponse = extractAndSaveCharacters(response, startIdx);
                
                // 그룹 요약 저장 - 응답에서 #X-Y 패턴 제거하고 저장 (0-indexed)
                const groupStartNum = startIdx;
                const groupEndNum = endIdx;
                
                // 응답에서 #X-Y 헤더 제거 (사전 컴파일된 정규식 사용)
                let finalContent = cleanedResponse.trim();
                finalContent = finalContent.replace(REGEX_GROUP_HEADER, '').trim();
                
                setSummaryForMessage(startIdx, `#${groupStartNum}-${groupEndNum}\n${finalContent}`);
                
                // 나머지 인덱스는 그룹에 포함됨 표시
                for (let i = startIdx + 1; i <= endIdx; i++) {
                    setSummaryForMessage(i, `[→ #${groupStartNum}-${groupEndNum} 그룹 요약에 포함]`);
                }
            } else {
                // 개별 요약 저장
                const parsed = parseApiResponse(response, startIdx, endIdx);
                const content = parsed[messageIndex] || response.trim();
                setSummaryForMessage(messageIndex, content);
            }
            
            await saveSummaryData();
            injectSummaryToPrompt();
            return { success: true, startIdx, endIdx };
        }
        
        return { success: false, error: "응답 없음" };
    } catch (error) {
        logError('resummarizeMessage', error, { messageIndex });
        return { success: false, error: error.message };
    }
}
