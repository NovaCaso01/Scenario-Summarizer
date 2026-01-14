/**
 * 시나리오 자동요약 - 요약 생성 핵심 로직
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { power_user } from "../../../../power-user.js";
import { 
    extensionName, 
    DEFAULT_PROMPT_TEMPLATE, 
    DEFAULT_BATCH_PROMPT_TEMPLATE,
    DEFAULT_EVENT_PROMPT_TEMPLATE,
    DEFAULT_ITEM_PROMPT_TEMPLATE,
    CHARACTER_EXTRACTION_BLOCKS,
    getCharacterJsonCleanupPattern,
    getEventJsonCleanupPattern,
    getItemJsonCleanupPattern,
    EVENT_OUTPUT_FORMAT_BLOCKS,
    ITEM_OUTPUT_FORMAT_BLOCKS,
    LANG_INSTRUCTIONS,
    LANG_REMINDERS
} from './constants.js';
import { log, getSettings, startSummarizing, stopSummarizing, shouldStop, isSummarizing, logError } from './state.js';
import { getSummaryData, saveSummaryData, setSummaryForMessage, formatCharactersText, mergeExtractedCharacters, getPreviousContext, getRecentSummariesForContext, addEvent, addItem } from './storage.js';
import { callSummaryAPI } from './api.js';
import { applyMessageVisibility } from './visibility.js';
import { injectSummaryToPrompt } from './injection.js';

// ===== 사전 컴파일된 정규식 =====
const REGEX_PREV_TIME = /\{\{PREV_TIME\}\}/g;
const REGEX_PREV_LOCATION = /\{\{PREV_LOCATION\}\}/g;
const REGEX_PREV_RELATIONSHIP = /\{\{PREV_RELATIONSHIP\}\}/g;
// 새 마커 형식 [CHARACTERS]와 구버전 [CHARACTERS_JSON] 모두 지원
const REGEX_CHARACTERS_BLOCK = /\[CHARACTERS(?:_JSON)?\]\s*([\s\S]*?)\s*\[\/.{0,5}CHARACTERS(?:_JSON)?\]/gi;
const REGEX_EVENTS_BLOCK = /\[EVENTS(?:_JSON)?\]\s*([\s\S]*?)\s*\[\/.{0,5}EVENTS(?:_JSON)?\]/gi;
const REGEX_ITEMS_BLOCK = /\[ITEMS(?:_JSON)?\]\s*([\s\S]*?)\s*\[\/.{0,5}ITEMS(?:_JSON)?\]/gi;
const REGEX_GROUP_HEADER = /^#\d+-\d+\s*\n?/;

/**
 * 요약 응답이 불완전한지 검증
 * @param {string} content - 요약 내용
 * @returns {boolean} - 불완전하면 true
 */
function isIncompleteSummary(content) {
    if (!content || content.trim().length < 15) return true;
    
    const trimmed = content.trim();
    
    // 따옴표가 열리고 닫히지 않음
    const doubleQuotes = (trimmed.match(/"/g) || []).length;
    if (doubleQuotes % 2 !== 0) return true;
    
    // 열린 괄호 확인
    const openParens = (trimmed.match(/[\(\[\{]/g) || []).length;
    const closeParens = (trimmed.match(/[\)\]\}]/g) || []).length;
    if (openParens > closeParens) return true;
    
    // [CHARACTERS] 또는 [CHARACTERS_JSON]이 열리고 닫히지 않음
    if ((trimmed.includes('[CHARACTERS]') && !trimmed.includes('[/CHARACTERS]')) ||
        (trimmed.includes('[CHARACTERS_JSON]') && !trimmed.includes('[/CHARACTERS_JSON]'))) return true;
    
    return false;
}

/**
 * 폴백 파싱: 정규식 실패 시 라인별 파싱 시도
 * @param {string} text - 파싱할 텍스트
 * @param {number} startNum - 시작 번호
 * @param {number} endNum - 끝 번호
 * @param {number} totalGroups - 전체 그룹 수 (단일 그룹일 때만 전체 추출 허용)
 * @returns {string|null} - 파싱된 요약 또는 null
 */
function parseFallback(text, startNum, endNum, totalGroups = 1) {
    try {
        const lines = text.split('\n');
        let inTargetGroup = false;
        let summaryLines = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // 그룹 헤더 감지 (다양한 형식 허용)
            const headerMatch = line.match(/^[#\[【]?\s*(\d+)\s*[-~]\s*(\d+)\s*[\]】]?/);
            
            if (headerMatch) {
                const groupStart = parseInt(headerMatch[1]);
                const groupEnd = parseInt(headerMatch[2]);
                
                if (groupStart === startNum && groupEnd === endNum) {
                    inTargetGroup = true;
                    continue;
                } else if (inTargetGroup) {
                    // 다른 그룹 시작 = 현재 그룹 종료
                    break;
                }
            }
            
            // 타겟 그룹 내용 수집
            if (inTargetGroup && line) {
                // 카테고리 라인 정규화 (*, -, •, ** 등 제거)
                const normalized = line.replace(/^[*\-•]+\s*\*?\s*/, '* ');
                summaryLines.push(normalized);
            }
        }
        
        // 타겟 그룹에서 정상적으로 추출된 경우에만 반환
        if (summaryLines.length > 0) {
            return summaryLines.join('\n');
        }
        
        // 그룹 헤더 자체가 없는 경우 - 단일 그룹일 때만 전체 추출 허용
        // 여러 그룹이 있는데 헤더가 없으면 파싱 실패로 처리 (중복 방지)
        if (totalGroups > 1) {
            log(`Fallback parsing rejected: multiple groups (${totalGroups}) but no group header found`);
            return null;
        }
        
        // 단일 그룹일 때만 전체 텍스트에서 카테고리 라인 추출
        const categoryPattern = /^[*\-•]\s*[^:：]+[:：]/;
        const extractedLines = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (categoryPattern.test(trimmed)) {
                const normalized = trimmed.replace(/^[*\-•]+\s*\*?\s*/, '* ');
                extractedLines.push(normalized);
            }
        }
        
        // 추출된 라인이 있고, 전체 텍스트 길이가 합리적인 경우에만 반환
        if (extractedLines.length > 0 && extractedLines.length <= 10) {
            return extractedLines.join('\n');
        }
        
        return null;
        
    } catch (e) {
        log(`Fallback parsing error: ${e.message}`);
        return null;
    }
}

/**
 * SillyTavern에서 프로필 정보 가져오기 (캐릭터 카드, 페르소나, 월드인포)
 * 요약 시 캐릭터와 유저의 컨텍스트 정보를 제공
 * @param {boolean} isRawPrompt - raw 프롬프트 모드 여부 (true면 캐릭터 Scenario 제외)
 * @returns {string} - 프로필 정보 텍스트
 */
function getProfileInfo(isRawPrompt = false) {
    const context = getContext();
    if (!context) return '';
    
    let profileText = '';
    
    // 1. 캐릭터 카드 정보
    try {
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
            // Raw 모드일 때는 Scenario 제외 (World Info에서 가져오므로 중복 방지)
            if (!isRawPrompt && charData.scenario) profileText += `* Scenario: ${charData.scenario}\n`;
            profileText += '\n';
        }
    } catch (e) {
        log(`Failed to get character data: ${e.message}`);
    }
    
    // 2. 유저 페르소나 정보
    try {
        const userName = context.name1 || '';
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
    
    // 3. 월드인포 / 로어북
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
    
    // 이벤트 추출 블록 (토글 활성화 시, 커스텀/기본 템플릿 + 언어별 출력 형식)
    const eventExtraction = settings.eventTrackingEnabled 
        ? (settings.customEventPromptTemplate || DEFAULT_EVENT_PROMPT_TEMPLATE) + '\n\n' + (EVENT_OUTPUT_FORMAT_BLOCKS[charExtractionLang] || EVENT_OUTPUT_FORMAT_BLOCKS.ko)
        : '';
    
    // 아이템 추출 블록 (토글 활성화 시, 커스텀/기본 템플릿 + 언어별 출력 형식)
    const itemExtraction = settings.itemTrackingEnabled 
        ? (settings.customItemPromptTemplate || DEFAULT_ITEM_PROMPT_TEMPLATE) + '\n\n' + (ITEM_OUTPUT_FORMAT_BLOCKS[charExtractionLang] || ITEM_OUTPUT_FORMAT_BLOCKS.ko)
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
    const langInstruction = LANG_INSTRUCTIONS[language] || LANG_INSTRUCTIONS['ko'];
    
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
    // raw 프롬프트 모드인지 확인
    const isRawPrompt = settings.useRawPrompt || false;
    const profileInfo = getProfileInfo(isRawPrompt);
    const profileSection = profileInfo ? `
## Reference Info (Character Card/Persona/World Info)
${profileInfo}
` : '';
    
    // 언어별 추가 리마인더 (출력 형식 앞에 추가) - 매우 강력
    const langReminder = LANG_REMINDERS[language] || LANG_REMINDERS['ko'];
    
    // 메시지 번호 범위 추출 (강조 문구용)
    const messageNumbers = messages.map(m => m.mes_id !== undefined ? m.mes_id : m.index).filter(n => n !== undefined);
    const minNum = Math.min(...messageNumbers);
    const maxNum = Math.max(...messageNumbers);
    const messageCount = messageNumbers.length;
    
    // 모든 메시지 요약 강제 강조 문구
    const completionEmphasis = messageCount > 1 ? `
## ⚠️⚠️⚠️ CRITICAL WARNING - DO NOT SKIP ANY MESSAGE ⚠️⚠️⚠️
**You MUST output summaries for ALL ${messageCount} messages from #${minNum} to #${maxNum}.**
**Do NOT stop early. Do NOT truncate. EVERY single message number MUST have its own complete summary.**
**If you skip any message, the entire response will be rejected and you will need to redo everything.**
**Complete list of required message numbers: ${messageNumbers.join(', ')}**
` : '';
    
    // 출력 형식 예시 생성 (메시지 번호 기반)
    const formatExample = messageCount > 1 ? `
Example output structure:
#${minNum}
* 시나리오: [summary for message ${minNum}]

#${minNum + 1}
* 시나리오: [summary for message ${minNum + 1}]

...continue for each message...

#${maxNum}
* 시나리오: [summary for message ${maxNum}]
` : '';
    
    // 최종 프롬프트 조립: 언어 + 지침 + 프로필정보 + 이전컨텍스트 + 이전요약 + 기존캐릭터 + 메시지 + 출력형식
    const prompt = `${langInstruction}

${userInstructions}
${profileSection}${contextInfo}${recentSummariesSection}
${existingChars}
## Messages to Summarize
${formattedMessages}
${completionEmphasis}${langReminder}
## Output Format (MANDATORY - Follow EXACTLY)
**⚠️ Output ONE separate section per message. Do NOT combine or merge multiple messages into one summary.**
**Each message MUST start with #MessageNumber on its own line.**

#MessageNumber
${categoryFormat || '* Scenario: (Integrate key events and dialogue narratively)'}
${formatExample}${characterExtraction}${eventExtraction}${itemExtraction}`;
    
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
                relationship: 'Current relationship status between characters - ALWAYS include even if unchanged'
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
    
    // 언어 설정 - 상수에서 가져옴
    const langInstruction = LANG_INSTRUCTIONS[language] || LANG_INSTRUCTIONS['ko'];
    
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
    
    // 이벤트 추출 블록 (토글 활성화 시, 커스텀/기본 템플릿 + 언어별 출력 형식)
    const eventExtraction = settings.eventTrackingEnabled 
        ? (settings.customEventPromptTemplate || DEFAULT_EVENT_PROMPT_TEMPLATE) + '\n\n' + (EVENT_OUTPUT_FORMAT_BLOCKS[charExtractionLang] || EVENT_OUTPUT_FORMAT_BLOCKS.ko)
        : '';
    
    // 아이템 추출 블록 (토글 활성화 시, 커스텀/기본 템플릿 + 언어별 출력 형식)
    const itemExtraction = settings.itemTrackingEnabled 
        ? (settings.customItemPromptTemplate || DEFAULT_ITEM_PROMPT_TEMPLATE) + '\n\n' + (ITEM_OUTPUT_FORMAT_BLOCKS[charExtractionLang] || ITEM_OUTPUT_FORMAT_BLOCKS.ko)
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
    // raw 프롬프트 모드인지 확인
    const isRawPrompt = settings.useRawPrompt || false;
    const profileInfo = getProfileInfo(isRawPrompt);
    const profileSection = profileInfo ? `
## Reference Info (Character Card/Persona/World Info)
${profileInfo}
` : '';
    
    // 언어별 추가 리마인더 (출력 형식 앞에 추가) - 매우 강력
    const langReminder = LANG_REMINDERS[language] || LANG_REMINDERS['ko'];
    
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
**IMPORTANT: Output summaries FIRST, then extraction blocks at the very end.**

#StartNumber-EndNumber
${outputFormatExample}

(repeat for each batch)
${characterExtraction}${eventExtraction}${itemExtraction}`;
    
    return prompt;
}

/**
 * AI 응답에서 캐릭터 추출 및 저장 (마커 형식 + JSON 형식 둘 다 지원)
 * @param {string} response - API 응답
 * @param {number} messageIndex - 첫 등장으로 기록할 메시지 인덱스
 * @returns {string} - 캐릭터 블록 부분이 제거된 응답
 */
function extractAndSaveCharacters(response, messageIndex) {
    const settings = getSettings();
    if (settings.characterTrackingEnabled === false) {
        log(`Character tracking disabled, skipping extraction`);
        return response;
    }
    
    // [CHARACTERS] 또는 [CHARACTERS_JSON] 블록이 있는지 확인
    const hasCharBlock = response.includes('[CHARACTERS]') || response.includes('[CHARACTERS_JSON]');
    log(`Character extraction: hasCharBlock=${hasCharBlock}, responseLength=${response.length}`);
    
    if (!hasCharBlock) {
        log(`No character block found in response`);
        return response;
    }
    
    // 정규식 리셋
    REGEX_CHARACTERS_BLOCK.lastIndex = 0;
    let match;
    let extractedCount = 0;
    
    while ((match = REGEX_CHARACTERS_BLOCK.exec(response)) !== null) {
        if (match[1]) {
            const content = match[1].trim();
            log(`Found character block: ${content.substring(0, 100)}...`);
            
            if (!content || content === '{}') {
                log(`Empty character block`);
                continue;
            }
            
            // JSON 형식인지 마커 형식인지 판단
            if (content.startsWith('{')) {
                // JSON 형식 (구버전 호환)
                try {
                    const characters = JSON.parse(content);
                    if (Object.keys(characters).length > 0) {
                        log(`Parsed ${Object.keys(characters).length} characters (JSON): ${Object.keys(characters).join(', ')}`);
                        mergeExtractedCharacters(characters, messageIndex);
                        extractedCount += Object.keys(characters).length;
                    }
                } catch (e) {
                    log(`Failed to parse character JSON: ${e.message}`);
                }
            } else {
                // 마커 형식: 이름 | 역할 | 나이 | 직업 | 외모 | 성격 | 관계 | 첫등장
                const lines = content.split('\n').filter(line => line.trim() && line.includes('|'));
                const characters = {};
                
                for (const line of lines) {
                    const parts = line.split('|').map(p => p.trim());
                    if (parts.length >= 2 && parts[0]) {
                        const name = parts[0];
                        const role = parts[1] || '';
                        const age = parts[2] || '';
                        const occupation = parts[3] || '';
                        const description = parts[4] || '';
                        const traitsStr = parts[5] || '';
                        const relationship = parts[6] || '';
                        const firstAppearanceStr = parts[7] || '';
                        
                        // traits 파싱 (쉼표 구분)
                        const traits = traitsStr ? traitsStr.split(',').map(t => t.trim()).filter(t => t && t !== 'N/A') : [];
                        
                        // firstAppearance 파싱
                        const firstAppearance = parseInt(firstAppearanceStr) || messageIndex;
                        
                        characters[name] = {
                            role: role !== 'N/A' ? role : '',
                            age: age !== 'N/A' ? age : '',
                            occupation: occupation !== 'N/A' ? occupation : '',
                            description: description !== 'N/A' ? description : '',
                            traits: traits,
                            relationshipWithUser: relationship !== 'N/A' ? relationship : '',
                            firstAppearance: firstAppearance
                        };
                    }
                }
                
                if (Object.keys(characters).length > 0) {
                    log(`Parsed ${Object.keys(characters).length} characters (marker): ${Object.keys(characters).join(', ')}`);
                    mergeExtractedCharacters(characters, messageIndex);
                    extractedCount += Object.keys(characters).length;
                }
            }
        }
    }
    
    if (extractedCount > 0) {
        log(`Extracted ${extractedCount} characters from response`);
    } else {
        log(`No characters extracted from response`);
    }
    
    // 캐릭터 블록 제거하여 반환
    const cleanedResponse = response.replace(getCharacterJsonCleanupPattern(), '').trim();
    
    return cleanedResponse;
}

/**
 * 이벤트 추출 및 저장 (마커 형식 + JSON 형식 둘 다 지원)
 * @param {string} response - API 응답
 * @param {number} messageIndex - 메시지 인덱스
 * @returns {string} - 이벤트 블록 부분을 제거한 응답
 */
function extractAndSaveEvents(response, messageIndex) {
    const settings = getSettings();
    
    // 이벤트 추적이 비활성화된 경우 정리만 하고 반환
    if (!settings.eventTrackingEnabled) {
        return response.replace(getEventJsonCleanupPattern(), '').trim();
    }
    
    // [EVENTS] 또는 [EVENTS_JSON] 블록이 있는지 확인
    if (!response.includes('[EVENTS]') && !response.includes('[EVENTS_JSON]')) {
        return response;
    }
    
    REGEX_EVENTS_BLOCK.lastIndex = 0;
    let match;
    let extractedCount = 0;
    
    while ((match = REGEX_EVENTS_BLOCK.exec(response)) !== null) {
        if (match[1]) {
            const content = match[1].trim();
            if (!content || content === '{}') continue;
            
            // JSON 형식인지 마커 형식인지 판단
            if (content.startsWith('{')) {
                // JSON 형식 (구버전 호환)
                try {
                    const data = JSON.parse(content);
                    if (data.events && Array.isArray(data.events)) {
                        for (const event of data.events) {
                            if (event.title) {
                                const eventMessageIndex = (event.messageIndex !== null && event.messageIndex !== undefined) 
                                    ? event.messageIndex 
                                    : messageIndex;
                                addEvent({
                                    title: event.title,
                                    description: event.description || '',
                                    participants: event.participants || [],
                                    importance: event.importance || 'high',
                                    date: new Date().toLocaleDateString('ko-KR'),
                                    messageIndex: eventMessageIndex
                                });
                                extractedCount++;
                            }
                        }
                    }
                } catch (e) {
                    log(`Failed to parse events JSON: ${e.message}`);
                }
            } else {
                // 마커 형식: 제목 | 설명 | 참여자 | 중요도 | 메시지번호
                const lines = content.split('\n').filter(line => line.trim() && line.includes('|'));
                
                for (const line of lines) {
                    const parts = line.split('|').map(p => p.trim());
                    if (parts.length >= 2 && parts[0]) {
                        const title = parts[0];
                        const description = parts[1] || '';
                        const participantsStr = parts[2] || '';
                        const importance = parts[3] || 'high';
                        const msgIndexStr = parts[4] || '';
                        
                        // participants 파싱 (쉼표 구분)
                        const participants = participantsStr ? participantsStr.split(',').map(p => p.trim()).filter(p => p) : [];
                        
                        // messageIndex 파싱
                        const eventMessageIndex = parseInt(msgIndexStr) || messageIndex;
                        
                        addEvent({
                            title: title,
                            description: description,
                            participants: participants,
                            importance: importance.toLowerCase() === 'high' || importance.toLowerCase() === 'medium' || importance.toLowerCase() === 'low' ? importance.toLowerCase() : 'high',
                            date: new Date().toLocaleDateString('ko-KR'),
                            messageIndex: eventMessageIndex
                        });
                        extractedCount++;
                    }
                }
            }
        }
    }
    
    if (extractedCount > 0) {
        log(`Extracted ${extractedCount} events from response`);
    }
    
    return response.replace(getEventJsonCleanupPattern(), '').trim();
}

/**
 * 아이템 추출 및 저장 (마커 형식 + JSON 형식 둘 다 지원)
 * @param {string} response - API 응답
 * @param {number} messageIndex - 메시지 인덱스
 * @returns {string} - 아이템 블록 부분을 제거한 응답
 */
function extractAndSaveItems(response, messageIndex) {
    const settings = getSettings();
    
    // 아이템 추적이 비활성화된 경우 정리만 하고 반환
    if (!settings.itemTrackingEnabled) {
        return response.replace(getItemJsonCleanupPattern(), '').trim();
    }
    
    // [ITEMS] 또는 [ITEMS_JSON] 블록이 있는지 확인
    if (!response.includes('[ITEMS]') && !response.includes('[ITEMS_JSON]')) {
        return response;
    }
    
    REGEX_ITEMS_BLOCK.lastIndex = 0;
    let match;
    let extractedCount = 0;
    
    while ((match = REGEX_ITEMS_BLOCK.exec(response)) !== null) {
        if (match[1]) {
            const content = match[1].trim();
            if (!content || content === '{}') continue;
            
            // JSON 형식인지 마커 형식인지 판단
            if (content.startsWith('{')) {
                // JSON 형식 (구버전 호환)
                try {
                    const data = JSON.parse(content);
                    if (data.items && Array.isArray(data.items)) {
                        for (const item of data.items) {
                            if (item.name) {
                                const itemMessageIndex = (item.messageIndex !== null && item.messageIndex !== undefined) 
                                    ? item.messageIndex 
                                    : messageIndex;
                                
                                addItem({
                                    name: item.name,
                                    description: item.description || '',
                                    owner: item.owner || '',
                                    origin: item.origin || '',
                                    status: item.status || '',
                                    messageIndex: itemMessageIndex
                                });
                                extractedCount++;
                            }
                        }
                    }
                } catch (e) {
                    log(`Failed to parse items JSON: ${e.message}`);
                }
            } else {
                // 마커 형식: 이름 | 설명 | 소유자 | 획득경위 | 상태 | 메시지번호
                const lines = content.split('\n').filter(line => line.trim() && line.includes('|'));
                
                for (const line of lines) {
                    const parts = line.split('|').map(p => p.trim());
                    if (parts.length >= 2 && parts[0]) {
                        const name = parts[0];
                        const description = parts[1] || '';
                        const owner = parts[2] || '';
                        const origin = parts[3] || '';
                        const status = parts[4] || '';
                        const msgIndexStr = parts[5] || '';
                        
                        // messageIndex 파싱
                        const itemMessageIndex = parseInt(msgIndexStr) || messageIndex;
                        
                        addItem({
                            name: name,
                            description: description,
                            owner: owner,
                            origin: origin,
                            status: status,
                            messageIndex: itemMessageIndex
                        });
                        extractedCount++;
                    }
                }
            }
        }
    }
    
    if (extractedCount > 0) {
        log(`Extracted ${extractedCount} items from response`);
    }
    
    return response.replace(getItemJsonCleanupPattern(), '').trim();
}

/**
 * 여러 그룹 응답 파싱
 * @param {string} response - API 응답
 * @param {Array} groups - 그룹 배열
 * @returns {Object} - { 인덱스: 요약내용 }
 */
export function parseBatchGroupsResponse(response, groups) {
    // 그룹 전체의 인덱스 범위 계산
    const firstIndex = groups.length > 0 ? groups[0].indices[0] : 0;
    const lastIndex = groups.length > 0 ? groups[groups.length - 1].indices[groups[groups.length - 1].indices.length - 1] : 0;
    
    // 먼저 캐릭터 추출 및 저장
    let cleanResponse = extractAndSaveCharacters(response, firstIndex);
    // 이벤트/아이템 추출 및 저장 (마지막 인덱스 사용 - 더 최신 시점)
    cleanResponse = extractAndSaveEvents(cleanResponse, lastIndex);
    cleanResponse = extractAndSaveItems(cleanResponse, lastIndex);
    const result = {};
    const totalGroups = groups.length;
    
    log(`Parsing batch groups response (${cleanResponse.length} chars), ${totalGroups} groups expected`);
    
    // 짧은 응답 감지: 그룹당 최소 100자 정도는 필요
    const minExpectedLength = totalGroups * 80;
    if (cleanResponse.length < minExpectedLength && totalGroups > 1) {
        log(`WARNING: Response too short (${cleanResponse.length} < ${minExpectedLength}). AI may have truncated or skipped summaries.`);
        log(`DEBUG: Short response content: ${cleanResponse.substring(0, 500)}`);
    }
    
    // 전체 응답이 불완전한지 먼저 체크
    if (isIncompleteSummary(cleanResponse)) {
        log(`WARNING: Incomplete API response detected, marking all groups for re-summarization`);
        for (const group of groups) {
            const startNum = group.indices[0];
            const endNum = group.indices[group.indices.length - 1];
            result[group.indices[0]] = `#${startNum}-${endNum}\n[⚠️ 불완전한 응답 - 재요약 필요]`;
            for (let i = 1; i < group.indices.length; i++) {
                result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
            }
        }
        return result;
    }
    
    // 각 그룹에 대해 패턴 매칭
    for (const group of groups) {
        const startNum = group.indices[0];
        const endNum = group.indices[group.indices.length - 1];
        
        // #시작-끝 패턴 찾기 - 글로벌 플래그 없이 사용하여 lastIndex 문제 방지
        const patterns = [
            new RegExp(`#${startNum}-${endNum}\\s*\\n([\\s\\S]*?)(?=#\\d+-\\d+|===|$)`),
            new RegExp(`#${startNum}\\s*[-~]\\s*${endNum}\\s*\\n([\\s\\S]*?)(?=#\\d+|===|$)`),
            new RegExp(`\\[#${startNum}-${endNum}\\]\\s*\\n?([\\s\\S]*?)(?=\\[#\\d+|===|$)`)
        ];
        
        let matched = false;
        for (const pattern of patterns) {
            const match = pattern.exec(cleanResponse);
            if (match && match[1].trim()) {
                const summary = match[1].trim();
                
                // 개별 그룹 요약도 불완전 여부 체크
                if (isIncompleteSummary(summary)) {
                    log(`WARNING: Incomplete summary for group #${startNum}-${endNum}`);
                    result[group.indices[0]] = `#${startNum}-${endNum}\n[⚠️ 불완전한 요약 - 재요약 권장]\n${summary}`;
                } else {
                    result[group.indices[0]] = `#${startNum}-${endNum}\n${summary}`;
                }
                
                // 나머지 인덱스는 그룹에 포함됨 표시
                for (let i = 1; i < group.indices.length; i++) {
                    result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
                }
                matched = true;
                break;
            }
        }
        
        // 매칭 실패 시, 폴백 파싱 시도 (그룹 수 전달)
        if (!matched) {
            log(`Pattern match failed for group #${startNum}-${endNum}, trying fallback parsing`);
            const fallbackSummary = parseFallback(cleanResponse, startNum, endNum, totalGroups);
            
            if (fallbackSummary) {
                // 폴백 결과도 불완전 여부 체크
                if (isIncompleteSummary(fallbackSummary)) {
                    result[group.indices[0]] = `#${startNum}-${endNum}\n[⚠️ 불완전한 요약 - 재요약 권장]\n${fallbackSummary}`;
                } else {
                    result[group.indices[0]] = `#${startNum}-${endNum}\n${fallbackSummary}`;
                }
                for (let i = 1; i < group.indices.length; i++) {
                    result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
                }
                log(`Fallback parsing succeeded for #${startNum}-${endNum}`);
            } else {
                // 폴백도 실패 시 플레이스홀더 - 태그는 반드시 남김
                log(`All parsing failed for #${startNum}-${endNum}, saving placeholder with tag`);
                result[group.indices[0]] = `#${startNum}-${endNum}\n[❌ 요약 파싱 실패 - 재요약 필요]`;
                for (let i = 1; i < group.indices.length; i++) {
                    result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
                }
            }
        }
    }
    
    // 모든 그룹에 대해 결과가 있어야 함 - 누락된 그룹도 플레이스홀더 저장
    for (const group of groups) {
        if (result[group.indices[0]] === undefined) {
            const startNum = group.indices[0];
            const endNum = group.indices[group.indices.length - 1];
            log(`Group #${startNum}-${endNum} was missing from results, adding placeholder`);
            result[group.indices[0]] = `#${startNum}-${endNum}\n[❌ 요약 누락 - 재요약 필요]`;
            for (let i = 1; i < group.indices.length; i++) {
                result[group.indices[i]] = `[→ #${startNum}-${endNum} 그룹 요약에 포함]`;
            }
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
    let cleanResponse = extractAndSaveCharacters(response, startIndex);
    // 이벤트/아이템 추출 및 저장 (endIndex 사용 - 더 최신 시점)
    cleanResponse = extractAndSaveEvents(cleanResponse, endIndex);
    cleanResponse = extractAndSaveItems(cleanResponse, endIndex);
    const result = {};
    
    log(`Parsing response (${cleanResponse.length} chars), startIndex=${startIndex}, endIndex=${endIndex}`);
    
    // 방법 1: 정규식으로 #숫자 헤더 기반 파싱 (다양한 형식 지원)
    // #숫자, **#숫자**, [#숫자], 【#숫자】, ## #숫자 등
    const headerPattern = /(?:^|\n)\s*(?:\*\*)?(?:##\s*)?[#\[【]?#?(\d+)[\]】]?(?:\*\*)?[:\s]*\n/g;
    const headers = [];
    let match;
    
    // 모든 헤더 위치와 번호 수집
    while ((match = headerPattern.exec(cleanResponse)) !== null) {
        headers.push({
            num: parseInt(match[1]),
            endPos: match.index + match[0].length  // 헤더 끝 위치 (내용 시작)
        });
    }
    
    log(`Found ${headers.length} headers in response`);
    
    if (headers.length > 0) {
        // 각 헤더의 내용 추출
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i];
            const nextPos = (i + 1 < headers.length) 
                ? cleanResponse.lastIndexOf('\n', headers[i + 1].endPos - headers[i + 1].toString().length)
                : cleanResponse.length;
            
            // 헤더 끝부터 다음 헤더 전까지 (또는 끝까지)
            const startPos = header.endPos;
            const content = cleanResponse.substring(startPos, nextPos).trim();
            
            // 인덱스 범위 체크
            if (header.num >= startIndex && header.num <= endIndex && content) {
                result[header.num] = content;
            }
        }
    }
    
    // 방법 1 실패 시, 방법 2: 간단한 split 기반 파싱
    if (Object.keys(result).length === 0) {
        log(`Header-based parsing failed, trying split-based parsing`);
        
        // #숫자 로 분할 (줄바꿈 없이도 가능)
        const parts = cleanResponse.split(/(?=(?:^|\n)\s*#\d+[\s:\n])/);
        
        for (const part of parts) {
            const numMatch = part.match(/^[\s\n]*#(\d+)[\s:\n]/);
            if (numMatch) {
                const num = parseInt(numMatch[1]);
                const content = part.replace(/^[\s\n]*#\d+[\s:\n]*/, '').trim();
                
                if (num >= startIndex && num <= endIndex && content) {
                    result[num] = content;
                }
            }
        }
    }
    
    // 방법 2도 실패 시, 방법 3: 순서 기반 파싱 (AI가 #0부터 시작한 경우)
    if (Object.keys(result).length === 0 && headers.length > 0) {
        log(`Trying order-based mapping (AI started from #0?)`);
        
        // 헤더 순서대로 요청 인덱스에 매핑
        const requestedIndices = [];
        for (let i = startIndex; i <= endIndex; i++) {
            requestedIndices.push(i);
        }
        
        for (let i = 0; i < Math.min(headers.length, requestedIndices.length); i++) {
            const header = headers[i];
            const nextPos = (i + 1 < headers.length) 
                ? cleanResponse.lastIndexOf('\n', headers[i + 1].endPos - 10)
                : cleanResponse.length;
            
            const content = cleanResponse.substring(header.endPos, nextPos).trim();
            if (content) {
                result[requestedIndices[i]] = content;
                log(`Mapped AI's #${header.num} to requested #${requestedIndices[i]}`);
            }
        }
    }
    
    // 파싱 결과 로깅
    if (Object.keys(result).length === 0) {
        log(`Failed to parse API response. First 500 chars: ${cleanResponse.substring(0, 500)}`);
    } else {
        log(`Successfully parsed ${Object.keys(result).length}/${endIndex - startIndex + 1} summaries`);
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
                    // 개별 모드: 파싱 성공한 것만 저장, 실패한 것은 마커
                    const prompt = buildSummaryPrompt(messagesToSummarize, indicesToProcess[0]);
                    const response = await callSummaryAPI(prompt);
                    
                    if (shouldStop()) break;
                    
                    if (response) {
                        const parsed = parseApiResponse(response, indicesToProcess[0], indicesToProcess[indicesToProcess.length - 1]);
                        
                        // 각 인덱스별로 처리: 파싱 성공/실패 구분
                        for (const idx of indicesToProcess) {
                            if (parsed[idx]) {
                                // 파싱 성공: 개별 불완전 여부 체크
                                if (isIncompleteSummary(parsed[idx])) {
                                    setSummaryForMessage(idx, `[⚠️ 불완전한 요약 - 재요약 권장]\n${parsed[idx]}`);
                                } else {
                                    setSummaryForMessage(idx, parsed[idx]);
                                }
                            } else {
                                // 파싱 실패: 실패 마커 저장
                                setSummaryForMessage(idx, `[❌ 요약 파싱 실패 - 재요약 필요]`);
                            }
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
        logError('runSummary', error, { customStart, customEnd });
        return { success: false, processed: 0, error: error.message };
    }
}

/**
 * 자동 요약 실행 (이벤트에서 호출)
 * @returns {Promise<boolean>}
 */
export async function runAutoSummary() {
    const settings = getSettings();
    
    log(`자동 요약 체크: enabled=${settings.enabled}, automaticMode=${settings.automaticMode}`);
    
    if (!settings.enabled || !settings.automaticMode) {
        log('자동 요약 스킵: 비활성화 또는 수동 모드');
        return false;
    }
    
    const context = getContext();
    const data = getSummaryData();
    
    if (!context.chat || !data) {
        log(`자동 요약 스킵: 채팅 또는 데이터 없음 (chat=${!!context.chat}, data=${!!data})`);
        return false;
    }
    
    // 요약 안 된 메시지 수 확인 (마지막 메시지 제외 - 스와이프/삭제 안전)
    const unsummarizedCount = countUnsummarizedMessages(data, context.chat, true);
    const interval = settings.summaryInterval || 10;
    const groupSize = settings.batchGroupSize || 10;
    
    log(`Auto-summary: ${unsummarizedCount} unsummarized messages (excluding last), interval=${interval}, groupSize=${groupSize}`);
    
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
        
        // 첫 번째 미요약 인덱스 찾기 (마지막 메시지 제외)
        const startIndex = findFirstUnsummarizedIndex(data, context.chat, true);
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
 * @param {boolean} excludeLastMessage - 마지막 메시지 제외 여부 (자동 요약 시 true)
 * @returns {number}
 */
function findFirstUnsummarizedIndex(data, chat, excludeLastMessage = false) {
    // 마지막 메시지 제외 옵션: 스와이프/삭제 등으로 인한 꼬임 방지
    const endIndex = excludeLastMessage ? chat.length - 1 : chat.length;
    
    for (let i = 0; i < endIndex; i++) {
        const msg = chat[i];
        // 유저가 숨긴 메시지가 아니고, 요약이 없으면
        if (!msg._userHidden && !isUserHiddenMessage(msg, i) && !data.summaries[i]) {
            return i;
        }
    }
    return chat.length; // 모두 요약됨
}

/**
 * 요약 안 된 메시지 수 세기 (자동 요약용: 마지막 메시지 제외)
 * @param {Object} data 
 * @param {Array} chat 
 * @param {boolean} excludeLastMessage - 마지막 메시지 제외 여부 (자동 요약 시 true)
 * @returns {number}
 */
function countUnsummarizedMessages(data, chat, excludeLastMessage = false) {
    let count = 0;
    // 마지막 메시지 제외 옵션: 스와이프/삭제 등으로 인한 꼬임 방지
    const endIndex = excludeLastMessage ? chat.length - 1 : chat.length;
    
    for (let i = 0; i < endIndex; i++) {
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
        // 이 메시지가 그룹 요약의 시작점 - 이미 0-indexed로 저장됨
        startIdx = parseInt(groupMatch[1]);
        endIdx = parseInt(groupMatch[2]);
    } else if (includedMatch) {
        // 이 메시지가 다른 그룹에 포함됨 - 이미 0-indexed로 저장됨
        startIdx = parseInt(includedMatch[1]);
        endIdx = parseInt(includedMatch[2]);
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

/**
 * 여러 그룹을 한 번의 API 호출로 재요약
 * @param {Array<{startIdx: number, endIdx: number}>} groupRanges - 재요약할 그룹 범위 배열
 * @returns {Promise<{success: boolean, successCount: number, failCount: number, error?: string}>}
 */
export async function resummarizeMultipleGroups(groupRanges) {
    const context = getContext();
    const settings = getSettings();
    
    if (!context.chat || groupRanges.length === 0) {
        return { success: false, successCount: 0, failCount: 0, error: "잘못된 입력" };
    }
    
    try {
        // 그룹 데이터 구성
        const groups = [];
        for (const range of groupRanges) {
            const indices = [];
            const messages = [];
            for (let i = range.startIdx; i <= range.endIdx; i++) {
                if (i < context.chat.length) {
                    indices.push(i);
                    messages.push(context.chat[i]);
                }
            }
            if (indices.length > 0) {
                groups.push({ indices, messages });
            }
        }
        
        if (groups.length === 0) {
            return { success: false, successCount: 0, failCount: 0, error: "유효한 그룹 없음" };
        }
        
        // 배치 그룹 프롬프트 생성 및 API 호출
        const prompt = buildBatchGroupsPrompt(groups, settings);
        const response = await callSummaryAPI(prompt);
        
        if (!response) {
            return { success: false, successCount: 0, failCount: groups.length, error: "응답 없음" };
        }
        
        // 응답 파싱
        const parsed = parseBatchGroupsResponse(response, groups);
        
        // 결과 저장
        let successCount = 0;
        let failCount = 0;
        
        for (const group of groups) {
            const startIdx = group.indices[0];
            const endIdx = group.indices[group.indices.length - 1];
            const summary = parsed[startIdx];
            
            if (summary && !summary.includes('파싱 실패') && !summary.includes('❌')) {
                // 성공: 모든 인덱스에 저장
                for (const idx of group.indices) {
                    setSummaryForMessage(idx, parsed[idx]);
                }
                successCount++;
            } else {
                // 실패
                failCount++;
            }
        }
        
        await saveSummaryData();
        injectSummaryToPrompt();
        
        return { success: true, successCount, failCount };
        
    } catch (error) {
        logError('resummarizeMultipleGroups', error, { groupCount: groupRanges.length });
        return { success: false, successCount: 0, failCount: groupRanges.length, error: error.message };
    }
}
