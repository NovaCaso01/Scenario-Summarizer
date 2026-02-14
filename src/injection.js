/**
 * 시나리오 자동요약 - 프롬프트 주입
 */

import { getContext } from "../../../../extensions.js";
import { setExtensionPrompt, extension_prompt_types } from "../../../../../script.js";
import { extensionName, isGroupIncludedContent, cleanJsonBlocks, cleanCatalogSections } from './constants.js';
import { log, getSettings, logError } from './state.js';
import { getSummaryData, getRelevantSummaries, getCharacterName, getRelevantCharacters, formatCharactersText, getLegacySummaries, getRelevantEvents, getRelevantItems } from './storage.js';
import { getTokenCounter } from './ui.js';

// setExtensionPrompt 사용 가능 여부
let extensionPromptAvailable = true;

// 잘린(skipped) 요약 인덱스 추적 (UI에서 참조)
let _skippedSummaryIndices = new Set();

// 토큰 추정 캐시 (dirty flag 패턴)
let _tokenCache = { hash: '', tokens: 0 };

/**
 * 토큰 캐시 무효화 (요약 변경 시 호출)
 */
export function invalidateTokenCache() {
    _tokenCache.hash = '';
    _tokenCache.tokens = 0;
}

/**
 * 간단한 해시 생성 (캐시 비교용)
 */
function quickHash(str) {
    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash + '_' + str.length;
}

/**
 * 텍스트의 토큰 수를 추정 (비동기 카운터 또는 폴백)
 * 단일 호출용 헬퍼
 */
async function countTokens(text, counter) {
    if (counter) return await counter(text);
    // 폴백
    const koreanChars = (text.match(/[\u3131-\uD79D]/g) || []).length;
    const otherChars = text.length - koreanChars;
    return Math.ceil(koreanChars / 2 + otherChars / 4);
}

/**
 * 여러 텍스트의 토큰 수를 일괄 추정 (전체를 한 번에 카운트 후 비율 분배)
 * @param {string[]} texts - 개별 텍스트 배열
 * @param {Function|null} counter - 비동기 토큰 카운터
 * @returns {Promise<number[]>} - 각 텍스트의 추정 토큰 수 배열
 */
async function batchCountTokens(texts, counter) {
    if (texts.length === 0) return [];
    
    // 전체를 합쳐 한 번만 카운트
    const separator = '\n';
    const combined = texts.join(separator);
    const totalTokens = await countTokens(combined, counter);
    
    // 길이 비율로 각 텍스트에 분배
    const totalLength = texts.reduce((sum, t) => sum + t.length, 0);
    if (totalLength === 0) return texts.map(() => 0);
    
    return texts.map(t => Math.ceil((t.length / totalLength) * totalTokens));
}

/**
 * 현재 토큰 예산 초과로 잘린 요약 인덱스 목록 반환
 * @returns {Set<number>}
 */
export function getSkippedSummaryIndices() {
    return _skippedSummaryIndices;
}

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
        const tokenBudget = settings.tokenBudget || 2000;
        const getTokenCountAsync = getTokenCounter();
    
    // ===== 1단계: 모든 콘텐츠 수집 (토큰 카운트 전) =====
    let summaryText = `# ${charName} Summary\n\n`;
    
    // 인계 요약 콘텐츠 수집
    const legacyItems = [];
    for (const order of legacyOrders) {
        const legacy = legacySummaries.find(s => s.order === order);
        if (!legacy) continue;
        const content = String(legacy.content ?? '');
        if (!content.trim()) continue;
        legacyItems.push({ order, content });
    }
    
    // 현재 요약 분류 (pinned / normal)
    const pinnedItems = [];
    const normalItems = [];
    
    for (const index of summaryIndices) {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        if (isGroupIncludedContent(content)) continue;
        if (summary?.invalidated === true) continue;
        
        if (summary?.pinned) {
            pinnedItems.push({ index, content });
        } else {
            normalItems.push({ index, content });
        }
    }
    
    // ===== 2단계: 일괄 토큰 추정 (1회 카운트) =====
    const allTexts = [
        summaryText,
        ...legacyItems.map(l => l.content),
        ...pinnedItems.map(p => p.content),
        ...normalItems.map(n => n.content)
    ];
    const allTokenCounts = await batchCountTokens(allTexts, getTokenCountAsync);
    
    let tokenIdx = 0;
    let estimatedTokens = allTokenCounts[tokenIdx++]; // 헤더 토큰
    let includedCount = 0;
    let skippedCount = 0;
    const includedLegacySummaries = [];
    const includedSummaries = [];
    _skippedSummaryIndices = new Set();
    
    // 1) 인계된 요약
    for (const item of legacyItems) {
        const contentTokens = allTokenCounts[tokenIdx++];
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedCount++;
            continue;
        }
        includedLegacySummaries.push({ order: item.order, content: item.content, isLegacy: true });
        estimatedTokens += contentTokens + 20;
        includedCount++;
    }
    
    // 2a) 핀 고정 요약
    for (const item of pinnedItems) {
        const contentTokens = allTokenCounts[tokenIdx++];
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedCount++;
            _skippedSummaryIndices.add(item.index);
            continue;
        }
        includedSummaries.push({ index: item.index, content: item.content });
        estimatedTokens += contentTokens + 20;
        includedCount++;
    }
    
    // 2b) 나머지 요약
    for (const item of normalItems) {
        const contentTokens = allTokenCounts[tokenIdx++];
        if (estimatedTokens + contentTokens > tokenBudget) {
            skippedCount++;
            _skippedSummaryIndices.add(item.index);
            continue;
        }
        includedSummaries.push({ index: item.index, content: item.content });
        estimatedTokens += contentTokens + 20;
        includedCount++;
    }
    
    if (includedCount === 0) {
        safeSetExtensionPrompt('', settings);
        return;
    }
    
    // ===== 3단계: 텍스트 조합 =====
    includedLegacySummaries.sort((a, b) => a.order - b.order);
    
    if (includedLegacySummaries.length > 0) {
        summaryText += `--- PREVIOUS STORY ---\n`;
        for (const { content } of includedLegacySummaries) {
            let cleanedContent = cleanJsonBlocks(content);
            cleanedContent = cleanCatalogSections(cleanedContent);
            const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
            if (rangeMatch) {
                cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
            }
            summaryText += cleanedContent + "\n\n";
        }
        summaryText += `--- CURRENT STORY ---\n`;
    }
    
    includedSummaries.sort((a, b) => a.index - b.index);
    
    for (const { index, content } of includedSummaries) {
        let cleanedContent = cleanJsonBlocks(content);
        const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
        if (rangeMatch) {
            summaryText += `### #${rangeMatch[1]}~${rangeMatch[2]}\n`;
            cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
        } else {
            summaryText += `### #${index}\n`;
        }
        summaryText += cleanedContent + "\n\n";
    }
    
    // 등장인물 / 이벤트 / 아이템 (각 1회 카운트)
    const relevantCharacters = getRelevantCharacters();
    if (Object.keys(relevantCharacters).length > 0) {
        const charactersText = formatCharactersText(true);
        if (charactersText) {
            const charTokens = await countTokens(charactersText, getTokenCountAsync);
            if (estimatedTokens + charTokens <= tokenBudget) {
                summaryText += `\n--- CHARACTERS ---\n`;
                summaryText += charactersText + "\n";
                estimatedTokens += charTokens;
            } else {
                log(`Characters section skipped: would exceed token budget (+${charTokens} tokens)`);
            }
        }
    }
    
    const eventsText = formatEventsText();
    if (eventsText) {
        const eventTokens = await countTokens(eventsText, getTokenCountAsync);
        if (estimatedTokens + eventTokens <= tokenBudget) {
            summaryText += `\n--- EVENTS ---\n`;
            summaryText += eventsText + "\n";
            estimatedTokens += eventTokens;
        } else {
            log(`Events section skipped: would exceed token budget (+${eventTokens} tokens)`);
        }
    }
    
    const itemsText = formatItemsText();
    if (itemsText) {
        const itemTokens = await countTokens(itemsText, getTokenCountAsync);
        if (estimatedTokens + itemTokens <= tokenBudget) {
            summaryText += `\n--- ITEMS ---\n`;
            summaryText += itemsText + "\n";
            estimatedTokens += itemTokens;
        } else {
            log(`Items section skipped: would exceed token budget (+${itemTokens} tokens)`);
        }
    }
    
    if (skippedCount > 0) {
        log(`Token budget exceeded: included=${includedCount}, skipped=${skippedCount}`);
    }
    
    // 프롬프트 주입
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
 * 현재 주입될 요약 텍스트 미리보기 (+ 토큰 수 캐시 반환)
 * @param {Object} [options] - 옵션
 * @param {boolean} [options.ignoreBudget=false] - true면 토큰 예산 무시 (전체 복사용)
 * @returns {Promise<{text: string, tokens: number}>}
 */
export async function getInjectionPreview(options = {}) {
    const { ignoreBudget = false } = options;
    try {
        const settings = getSettings();
        const summaries = getRelevantSummaries();
        const legacySummaries = getLegacySummaries();
        
        const summaryIndices = Object.keys(summaries).map(Number).sort((a, b) => b - a);
        const legacyOrders = legacySummaries.map(s => s.order).sort((a, b) => b - a);
        
        if (summaryIndices.length === 0 && legacyOrders.length === 0) {
            return { text: "(주입할 요약 없음)", tokens: 0 };
        }
        
        const charName = getCharacterName();
        const tokenBudget = settings.tokenBudget || 2000;
        const getTokenCountAsync = getTokenCounter();
    
    let text = `# ${charName} Summary\n\n`;
    
    // 콘텐츠 수집
    const legacyItems = [];
    for (const order of legacyOrders) {
        const legacy = legacySummaries.find(s => s.order === order);
        if (!legacy) continue;
        const content = String(legacy.content ?? '');
        if (!content.trim()) continue;
        legacyItems.push({ order, content });
    }
    
    const currentItems = [];
    for (const index of summaryIndices) {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        if (isGroupIncludedContent(content)) continue;
        currentItems.push({ index, content });
    }
    
    // 일괄 토큰 카운트 (ignoreBudget이 아닐 때만)
    let tokenCounts = null;
    let estimatedTokens = 0;
    
    if (!ignoreBudget) {
        const allTexts = [text, ...legacyItems.map(l => l.content), ...currentItems.map(c => c.content)];
        tokenCounts = await batchCountTokens(allTexts, getTokenCountAsync);
        estimatedTokens = tokenCounts[0]; // 헤더
    }
    
    const includedLegacySummaries = [];
    const includedSummaries = [];
    let skippedFromBudget = 0;
    let tokenIdx = 1;
    
    // 인계 요약
    for (const item of legacyItems) {
        if (!ignoreBudget) {
            const contentTokens = tokenCounts[tokenIdx++];
            if (estimatedTokens + contentTokens > tokenBudget) {
                skippedFromBudget++;
                continue;
            }
            estimatedTokens += contentTokens + 20;
        } else {
            tokenIdx++;
        }
        includedLegacySummaries.push({ order: item.order, content: item.content });
    }
    
    // 현재 요약
    for (const item of currentItems) {
        if (!ignoreBudget) {
            const contentTokens = tokenCounts[tokenIdx++];
            if (estimatedTokens + contentTokens > tokenBudget) {
                skippedFromBudget++;
                continue;
            }
            estimatedTokens += contentTokens + 20;
        } else {
            tokenIdx++;
        }
        includedSummaries.push({ index: item.index, content: item.content });
    }
    
    // 텍스트 조합
    includedLegacySummaries.sort((a, b) => a.order - b.order);
    
    if (includedLegacySummaries.length > 0) {
        text += `--- PREVIOUS STORY ---\n`;
        for (const { content } of includedLegacySummaries) {
            let cleanedContent = cleanJsonBlocks(content);
            const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
            if (rangeMatch) {
                cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
            }
            text += cleanedContent + "\n\n";
        }
        text += `--- CURRENT STORY ---\n`;
    }
    
    includedSummaries.sort((a, b) => a.index - b.index);
    
    for (const { index, content } of includedSummaries) {
        let cleanedContent = cleanJsonBlocks(content);
        const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
        if (rangeMatch) {
            text += `### #${rangeMatch[1]}~${rangeMatch[2]}\n`;
            cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
        } else {
            text += `### #${index}\n`;
        }
        text += cleanedContent + "\n\n";
    }
    
    // 등장인물/이벤트/아이템
    const relevantCharacters = getRelevantCharacters();
    if (Object.keys(relevantCharacters).length > 0) {
        const charactersText = formatCharactersText(true);
        if (charactersText) {
            text += `\n--- CHARACTERS ---\n`;
            text += charactersText + "\n";
        }
    }
    
    const eventsText = formatEventsText();
    if (eventsText) {
        text += `\n--- EVENTS ---\n`;
        text += eventsText + "\n";
    }
    
    const itemsText = formatItemsText();
    if (itemsText) {
        text += `\n--- ITEMS ---\n`;
        text += itemsText + "\n";
    }
    
    if (skippedFromBudget > 0) {
        text += `\n... (토큰 예산 초과로 오래된 요약 ${skippedFromBudget}개 생략) ...`;
    }
    
    // 최종 토큰 카운트 (캐시에 저장)
    if (!ignoreBudget) {
        _tokenCache.tokens = estimatedTokens;
    }
    
    return { text, tokens: estimatedTokens };
    } catch (error) {
        logError('getInjectionPreview', error);
        return { text: `(미리보기 생성 실패: ${error.message})`, tokens: 0 };
    }
}
