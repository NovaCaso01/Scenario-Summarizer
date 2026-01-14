/**
 * 시나리오 자동요약 - 프롬프트 주입
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { setExtensionPrompt, extension_prompt_types } from "../../../../../script.js";
import { extensionName, getCharacterJsonCleanupPattern, getEventJsonCleanupPattern, getItemJsonCleanupPattern } from './constants.js';
import { log, getSettings, logError } from './state.js';
import { getSummaryData, getRelevantSummaries, getCharacterName, getRelevantCharacters, formatCharactersText, getLegacySummaries, getRelevantEvents, getRelevantItems } from './storage.js';
import { getTokenCounter } from './ui.js';

// setExtensionPrompt 사용 가능 여부
let extensionPromptAvailable = true;

/**
 * 이벤트 목록을 텍스트로 포맷팅 (분기 대응, 중요도 포함)
 * @returns {string}
 */
function formatEventsText() {
    const events = getRelevantEvents();
    if (events.length === 0) return '';
    
    const settings = getSettings();
    const lang = settings.summaryLanguage || 'ko';
    
    // 중요도 라벨 (언어별)
    const importanceLabels = {
        'ko': { 'high': '높음', 'medium': '중간', 'low': '낮음' },
        'en': { 'high': 'HIGH', 'medium': 'MED', 'low': 'LOW' },
        'ja': { 'high': '高', 'medium': '中', 'low': '低' },
        'zh': { 'high': '高', 'medium': '中', 'low': '低' },
        'hybrid': { 'high': 'HIGH', 'medium': 'MED', 'low': 'LOW' }
    };
    const langLabels = importanceLabels[lang] || importanceLabels['en'];
    
    let text = '';
    for (const event of events) {
        // 중요도 태그
        const importance = event.importance || 'medium';
        const impLabel = langLabels[importance] || langLabels['medium'];
        
        text += `- [${impLabel}] ${event.title}`;
        if (event.messageIndex !== null && event.messageIndex !== undefined) {
            text += ` (#${event.messageIndex})`;
        }
        text += '\n';
        if (event.description) {
            text += `  ${event.description}\n`;
        }
    }
    return text;
}

/**
 * 아이템 목록을 텍스트로 포맷팅 (분기 대응, 중요도 포함)
 * @returns {string}
 */
function formatItemsText() {
    const items = getRelevantItems();
    if (items.length === 0) return '';
    
    const settings = getSettings();
    const lang = settings.summaryLanguage || 'ko';
    
    // 중요도 라벨 (언어별)
    const importanceLabelsMap = {
        'ko': { 'high': '높음', 'medium': '중간', 'low': '낮음' },
        'en': { 'high': 'HIGH', 'medium': 'MED', 'low': 'LOW' },
        'ja': { 'high': '高', 'medium': '中', 'low': '低' },
        'zh': { 'high': '高', 'medium': '中', 'low': '低' },
        'hybrid': { 'high': 'HIGH', 'medium': 'MED', 'low': 'LOW' }
    };
    const importanceLabels = importanceLabelsMap[lang] || importanceLabelsMap['en'];
    
    let text = '';
    for (const item of items) {
        const importance = item.importance || 'medium';
        const impLabel = importanceLabels[importance] || importanceLabels['medium'];
        
        // 상태는 AI가 작성한 그대로 출력
        text += `- [${impLabel}] ${item.name}`;
        if (item.status) {
            text += ` [${item.status}]`;
        }
        if (item.owner) {
            const ownerLabel = (lang === 'ko') ? '소유:' : (lang === 'zh') ? '所有:' : (lang === 'ja') ? '所有:' : 'by:';
            text += ` ${ownerLabel}${item.owner}`;
        }
        text += '\n';
        if (item.description) {
            text += `  ${item.description}\n`;
        }
    }
    return text;
}

/**
 * 요약 콘텐츠에서 모든 JSON 블록 제거 (CHARACTERS, EVENTS, ITEMS)
 * @param {string} content - 요약 콘텐츠
 * @returns {string} - 정리된 콘텐츠
 */
function cleanSummaryContent(content) {
    if (!content) return content;
    // 모든 JSON 블록 제거
    let cleaned = content;
    cleaned = cleaned.replace(getCharacterJsonCleanupPattern(), '');
    cleaned = cleaned.replace(getEventJsonCleanupPattern(), '');
    cleaned = cleaned.replace(getItemJsonCleanupPattern(), '');
    return cleaned.trim();
}

/**
 * 안전하게 setExtensionPrompt 호출
 * @param {string} summaryContent - 요약 내용
 * @param {Object} settings - 설정 객체
 * @returns {boolean}
 */
function safeSetExtensionPrompt(summaryContent, settings = null) {
    if (!extensionPromptAvailable) {
        return false;
    }
    
    try {
        if (typeof setExtensionPrompt === 'function') {
            // 설정에서 주입 위치 가져오기
            const position = settings?.injectionPosition || 'in-chat';
            const depth = settings?.injectionDepth !== undefined ? settings.injectionDepth : 0;
            
            // 요약 내용이 있으면 고정 포맷 적용, 없으면 빈 문자열
            const content = summaryContent ? `[Scenario Summary]\n${summaryContent}` : '';
            
            // 위치에 따라 extension_prompt_types 선택
            let promptType;
            if (position === 'before-main') {
                promptType = extension_prompt_types.BEFORE_PROMPT;
            } else if (position === 'after-main') {
                promptType = extension_prompt_types.AFTER_PROMPT || extension_prompt_types.IN_PROMPT;
            } else {
                // in-chat (default)
                promptType = extension_prompt_types.IN_CHAT;
            }
            
            setExtensionPrompt(
                extensionName,
                content,
                promptType,
                depth
            );
            return true;
        } else {
            extensionPromptAvailable = false;
            log('setExtensionPrompt 사용 불가');
            return false;
        }
    } catch (error) {
        log(`Failed to set extension prompt: ${error.message}`);
        return false;
    }
}

/**
 * 요약을 프롬프트에 주입
 */
export async function injectSummaryToPrompt() {
    try {
        const settings = getSettings();
        
        // 비활성화면 주입 제거
        if (!settings.enabled) {
            safeSetExtensionPrompt('', settings);
            return;
        }
        
        const context = getContext();
        if (!context.chat || context.chat.length === 0) {
            safeSetExtensionPrompt('', settings);
            return;
        }
        
        const summaries = getRelevantSummaries();
        const legacySummaries = getLegacySummaries();
        
        // 최신순(내림차순)으로 정렬하여 토큰 초과 시 오래된 요약이 제외되도록 함
        const summaryIndices = Object.keys(summaries).map(Number).sort((a, b) => b - a);
        
        // 인계된 요약도 역순으로 (order 기준)
        const legacyOrders = legacySummaries.map(s => s.order).sort((a, b) => b - a);
        
        if (summaryIndices.length === 0 && legacyOrders.length === 0) {
            safeSetExtensionPrompt('', settings);
            return;
        }
        
        const charName = getCharacterName();
        const data = getSummaryData();
        const tokenBudget = settings.tokenBudget || 2000;
        const getTokenCountAsync = getTokenCounter();
    
    // 토큰 예산 내에서 요약 구성
    let summaryText = `# ${charName} Summary\n\n`;
    
    let estimatedTokens = getTokenCountAsync ? await getTokenCountAsync(summaryText) : Math.ceil(summaryText.length / 4);
    let includedCount = 0;
    let skippedCount = 0;
    const includedLegacySummaries = [];
    const includedSummaries = [];
    
    // 1) 인계된 요약 먼저 처리 (최신 것부터 추가하여 토큰 초과 시 오래된 것 제외)
    for (const order of legacyOrders) {
        const legacy = legacySummaries.find(s => s.order === order);
        if (!legacy) continue;
        
        const content = String(legacy.content ?? '');
        if (!content.trim()) continue;
        
        const contentTokens = getTokenCountAsync ? await getTokenCountAsync(content) : Math.ceil(content.length / 4);
        
        // 토큰 예산 확인
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedCount++;
            continue;
        }
        
        includedLegacySummaries.push({ order, content, isLegacy: true });
        estimatedTokens += contentTokens + 20;
        includedCount++;
    }
    
    // 2) 현재 채팅 요약 처리 (최신 것부터 추가)
    for (const index of summaryIndices) {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        
        // 그룹 요약에 포함된 항목은 건너뛰기
        if (content.startsWith('[\u2192') || content.includes('그룹 요약에 포함')) {
            continue;
        }
        
        // 무효화된 요약은 건너뛰기
        if (summary?.invalidated === true) {
            continue;
        }
        
        const contentTokens = getTokenCountAsync ? await getTokenCountAsync(content) : Math.ceil(content.length / 4);
        
        // 토큰 예산 확인
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedCount++;
            continue;
        }
        
        // 요약 정보 저장 (나중에 오름차순으로 정렬하여 출력)
        includedSummaries.push({ index, content });
        estimatedTokens += contentTokens + 20; // 헤더 포함
        includedCount++;
    }
    
    if (includedCount === 0) {
        safeSetExtensionPrompt('', settings);
        return;
    }
    
    // 인계된 요약을 order 오름차순으로 정렬하여 시간순 출력
    includedLegacySummaries.sort((a, b) => a.order - b.order);
    
    // 인계된 요약이 있으면 먼저 출력
    if (includedLegacySummaries.length > 0) {
        summaryText += `--- PREVIOUS STORY ---\n`;
        for (const { order, content } of includedLegacySummaries) {
            let cleanedContent = cleanSummaryContent(content);
            // 그룹 요약인 경우 번호 범위 표시 제거
            const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
            if (rangeMatch) {
                cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
            }
            summaryText += cleanedContent + "\n\n";
        }
        summaryText += `--- CURRENT STORY ---\n`;
    }
    
    // 포함된 요약을 오름차순으로 정렬하여 시간순으로 출력
    includedSummaries.sort((a, b) => a.index - b.index);
    
    for (const { index, content } of includedSummaries) {
        // 빈 CHARACTERS_JSON 블록 제거
        let cleanedContent = cleanSummaryContent(content);
        // 그룹 요약인 경우 번호 범위 표시
        const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
        if (rangeMatch) {
            summaryText += `### #${rangeMatch[1]}~${rangeMatch[2]}\n`;
            // 내용에서 중복되는 #X-Y 헤더 제거
            cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
        } else {
            summaryText += `### #${index}\n`;
        }
        summaryText += cleanedContent + "\n\n";
    }
    
    // 등장인물 정보 추가 (한 번만)
    const relevantCharacters = getRelevantCharacters();
    if (Object.keys(relevantCharacters).length > 0) {
        const charactersText = formatCharactersText(true);
        if (charactersText) {
            summaryText += `\n--- CHARACTERS ---\n`;
            summaryText += charactersText + "\n";
            const charTokens = getTokenCountAsync ? await getTokenCountAsync(charactersText) : Math.ceil(charactersText.length / 4);
            estimatedTokens += charTokens;
        }
    }
    
    // 주요 이벤트 정보 추가
    const eventsText = formatEventsText();
    if (eventsText) {
        summaryText += `\n--- EVENTS ---\n`;
        summaryText += eventsText + "\n";
        const eventTokens = getTokenCountAsync ? await getTokenCountAsync(eventsText) : Math.ceil(eventsText.length / 4);
        estimatedTokens += eventTokens;
    }
    
    // 주요 아이템 정보 추가
    const itemsText = formatItemsText();
    if (itemsText) {
        summaryText += `\n--- ITEMS ---\n`;
        summaryText += itemsText + "\n";
        const itemTokens = getTokenCountAsync ? await getTokenCountAsync(itemsText) : Math.ceil(itemsText.length / 4);
        estimatedTokens += itemTokens;
    }
    
    if (skippedCount > 0) {
        log(`Token budget exceeded: included=${includedCount}, skipped=${skippedCount}`);
    }
    
    // 프롬프트 주입 (템플릿 적용된 형태로)
    const success = safeSetExtensionPrompt(summaryText, settings);
    
    if (success) {
        const legacyCount = includedLegacySummaries.length;
        const currentCount = includedSummaries.length;
        log(`Summary injected: ${legacyCount} legacy + ${currentCount} current entries, ~${Math.round(estimatedTokens)} tokens`);
    }
    } catch (error) {
        logError('injectSummaryToPrompt', error, { 
            hasSettings: !!getSettings(),
            summariesCount: Object.keys(getRelevantSummaries() || {}).length
        });
        log(`Injection failed: ${error.message}`);
    }
}

/**
 * 프롬프트 주입 제거
 */
export function clearInjection() {
    const settings = getSettings();
    safeSetExtensionPrompt('', settings);
    log('요약 주입 제거됨');
}

/**
 * 현재 주입될 요약 텍스트 미리보기
 * @returns {Promise<string>}
 */
export async function getInjectionPreview() {
    try {
        const settings = getSettings();
        const summaries = getRelevantSummaries();
        const legacySummaries = getLegacySummaries();
        
        // 최신순(내림차순)으로 정렬하여 토큰 초과 시 오래된 요약이 제외되도록 함
        const summaryIndices = Object.keys(summaries).map(Number).sort((a, b) => b - a);
        const legacyOrders = legacySummaries.map(s => s.order).sort((a, b) => b - a);
        
        if (summaryIndices.length === 0 && legacyOrders.length === 0) {
            return "(주입할 요약 없음)";
        }
        
        const charName = getCharacterName();
        const data = getSummaryData();
        const tokenBudget = settings.tokenBudget || 2000;
        const getTokenCountAsync = getTokenCounter();
    
    let text = `# ${charName} Summary\n\n`;
    
    let estimatedTokens = getTokenCountAsync ? await getTokenCountAsync(text) : Math.ceil(text.length / 4);
    const includedLegacySummaries = [];
    const includedSummaries = [];
    let skippedFromBudget = 0;
    
    // 1) 인계된 요약 먼저 처리
    for (const order of legacyOrders) {
        const legacy = legacySummaries.find(s => s.order === order);
        if (!legacy) continue;
        
        const content = String(legacy.content ?? '');
        if (!content.trim()) continue;
        
        const contentTokens = getTokenCountAsync ? await getTokenCountAsync(content) : Math.ceil(content.length / 4);
        
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedFromBudget++;
            continue;
        }
        
        includedLegacySummaries.push({ order, content });
        estimatedTokens += contentTokens + 20;
    }
    
    // 2) 현재 채팅 요약 처리
    for (const index of summaryIndices) {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        
        // 그룹 요약에 포함된 항목은 건너뛰기
        if (content.startsWith('[\u2192') || content.includes('그룹 요약에 포함')) {
            continue;
        }
        
        const contentTokens = getTokenCountAsync ? await getTokenCountAsync(content) : Math.ceil(content.length / 4);
        
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedFromBudget++;
            continue;
        }
        
        includedSummaries.push({ index, content });
        estimatedTokens += contentTokens + 20;
    }
    
    // 인계된 요약을 order 오름차순으로 정렬
    includedLegacySummaries.sort((a, b) => a.order - b.order);
    
    // 인계된 요약 출력
    if (includedLegacySummaries.length > 0) {
        text += `--- PREVIOUS STORY ---\n`;
        for (const { order, content } of includedLegacySummaries) {
            let cleanedContent = cleanSummaryContent(content);
            const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
            if (rangeMatch) {
                cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
            }
            text += cleanedContent + "\n\n";
        }
        text += `--- CURRENT STORY ---\n`;
    }
    
    // 포함된 요약을 오름차순으로 정렬하여 시간순으로 출력
    includedSummaries.sort((a, b) => a.index - b.index);
    
    for (const { index, content } of includedSummaries) {
        // 빈 CHARACTERS_JSON 블록 제거
        let cleanedContent = cleanSummaryContent(content);
        // 그룹 요약인 경우 번호 범위 표시
        const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
        if (rangeMatch) {
            text += `### #${rangeMatch[1]}~${rangeMatch[2]}\n`;
            // 내용에서 중복되는 #X-Y 헤더 제거
            cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
        } else {
            text += `### #${index}\n`;
        }
        text += cleanedContent + "\n\n";
    }
    
    // 등장인물 정보 추가 (한 번만)
    const relevantCharacters = getRelevantCharacters();
    if (Object.keys(relevantCharacters).length > 0) {
        const charactersText = formatCharactersText(true);
        if (charactersText) {
            text += `\n--- CHARACTERS ---\n`;
            text += charactersText + "\n";
        }
    }
    
    // 주요 이벤트 정보 추가
    const eventsText = formatEventsText();
    if (eventsText) {
        text += `\n--- EVENTS ---\n`;
        text += eventsText + "\n";
    }
    
    // 주요 아이템 정보 추가
    const itemsText = formatItemsText();
    if (itemsText) {
        text += `\n--- ITEMS ---\n`;
        text += itemsText + "\n";
    }
    
    if (skippedFromBudget > 0) {
        text += `\n... (토큰 예산 초과로 오래된 요약 ${skippedFromBudget}개 생략) ...`;
    }
    
    return text;
    } catch (error) {
        logError('getInjectionPreview', error);
        return `(미리보기 생성 실패: ${error.message})`;
    }
}
