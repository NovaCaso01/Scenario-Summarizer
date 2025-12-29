/**
 * 시나리오 자동요약 - 프롬프트 주입
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { setExtensionPrompt, extension_prompt_types } from "../../../../../script.js";
import { extensionName, getCharacterJsonCleanupPattern } from './constants.js';
import { log, getSettings, logError } from './state.js';
import { getSummaryData, getRelevantSummaries, getCharacterName, getRelevantCharacters, formatCharactersText } from './storage.js';
import { getTokenCounter } from './ui.js';

// setExtensionPrompt 사용 가능 여부
let extensionPromptAvailable = true;

/**
 * 요약 콘텐츠에서 빈 CHARACTERS_JSON 블록 제거
 * @param {string} content - 요약 콘텐츠
 * @returns {string} - 정리된 콘텐츠
 */
function cleanSummaryContent(content) {
    if (!content) return content;
    // 모든 [CHARACTERS_JSON]...[/CHARACTERS_JSON] 블록 제거
    return content.replace(getCharacterJsonCleanupPattern(), '').trim();
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
            log('setExtensionPrompt not available');
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
        // 최신순(내림차순)으로 정렬하여 토큰 초과 시 오래된 요약이 제외되도록 함
        const summaryIndices = Object.keys(summaries).map(Number).sort((a, b) => b - a);
        
        if (summaryIndices.length === 0) {
            safeSetExtensionPrompt('', settings);
            return;
        }
        
        const charName = getCharacterName();
        const data = getSummaryData();
        const tokenBudget = settings.tokenBudget || 2000;
        const getTokenCountAsync = getTokenCounter();
    
    // 토큰 예산 내에서 요약 구성
    let summaryText = `[${charName} 시나리오 요약]\n`;
    summaryText += `${"=".repeat(40)}\n\n`;
    
    let estimatedTokens = getTokenCountAsync ? await getTokenCountAsync(summaryText) : Math.ceil(summaryText.length / 4);
    let includedCount = 0;
    let skippedCount = 0;
    const includedSummaries = [];
    
    // 최신 것부터 추가하여 토큰 초과 시 오래된 요약이 제외되도록
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
    
    // 포함된 요약을 오름차순으로 정렬하여 시간순으로 출력
    includedSummaries.sort((a, b) => a.index - b.index);
    
    for (const { index, content } of includedSummaries) {
        // 빈 CHARACTERS_JSON 블록 제거
        let cleanedContent = cleanSummaryContent(content);
        // 그룹 요약인 경우 번호 범위 표시
        const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
        if (rangeMatch) {
            summaryText += `--- #${rangeMatch[1]}~${rangeMatch[2]} ---\n`;
            // 내용에서 중복되는 #X-Y 헤더 제거
            cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
        } else {
            summaryText += `--- #${index} ---\n`;
            // 개별 요약에서도 중복되는 #숫자 헤더 제거
            cleanedContent = cleanedContent.replace(/^#\d+\n?/, '').trim();
        }
        summaryText += cleanedContent + "\n\n";
    }
    
    // 등장인물 정보 추가 (한 번만)
    const relevantCharacters = getRelevantCharacters();
    if (relevantCharacters.length > 0) {
        const charactersText = formatCharactersText(true);
        if (charactersText) {
            summaryText += `[등장인물 정보]\n`;
            summaryText += charactersText + "\n";
            const charTokens = getTokenCountAsync ? await getTokenCountAsync(charactersText) : Math.ceil(charactersText.length / 4);
            estimatedTokens += charTokens;
        }
    }
    
    if (skippedCount > 0) {
        log(`Token budget exceeded: included=${includedCount}, skipped=${skippedCount}`);
    }
    
    // 프롬프트 주입 (템플릿 적용된 형태로)
    const success = safeSetExtensionPrompt(summaryText, settings);
    
    if (success) {
        log(`Summary injected: ${includedCount} entries, ~${Math.round(estimatedTokens)} tokens`);
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
    log('Summary injection cleared');
}

/**
 * 현재 주입될 요약 텍스트 미리보기
 * @returns {Promise<string>}
 */
export async function getInjectionPreview() {
    try {
        const settings = getSettings();
        const summaries = getRelevantSummaries();
        // 최신순(내림차순)으로 정렬하여 토큰 초과 시 오래된 요약이 제외되도록 함
        const summaryIndices = Object.keys(summaries).map(Number).sort((a, b) => b - a);
        
        if (summaryIndices.length === 0) {
            return "(주입할 요약 없음)";
        }
        
        const charName = getCharacterName();
        const data = getSummaryData();
        const tokenBudget = settings.tokenBudget || 2000;
        const getTokenCountAsync = getTokenCounter();
    
    let text = `[${charName} 시나리오 요약]\n`;
    text += `${"=".repeat(40)}\n\n`;
    
    let estimatedTokens = getTokenCountAsync ? await getTokenCountAsync(text) : Math.ceil(text.length / 4);
    const includedSummaries = [];
    let skippedFromBudget = 0;
    
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
    
    // 포함된 요약을 오름차순으로 정렬하여 시간순으로 출력
    includedSummaries.sort((a, b) => a.index - b.index);
    
    for (const { index, content } of includedSummaries) {
        // 빈 CHARACTERS_JSON 블록 제거
        let cleanedContent = cleanSummaryContent(content);
        // 그룹 요약인 경우 번호 범위 표시
        const rangeMatch = cleanedContent.match(/^#(\d+)-(\d+)/);
        if (rangeMatch) {
            text += `--- #${rangeMatch[1]}~${rangeMatch[2]} ---\n`;
            // 내용에서 중복되는 #X-Y 헤더 제거
            cleanedContent = cleanedContent.replace(/^#\d+-\d+\n?/, '').trim();
        } else {
            text += `--- #${index} ---\n`;
            // 개별 요약에서도 중복되는 #숫자 헤더 제거
            cleanedContent = cleanedContent.replace(/^#\d+\n?/, '').trim();
        }
        text += cleanedContent + "\n\n";
    }
    
    // 등장인물 정보 추가 (한 번만)
    const relevantCharacters = getRelevantCharacters();
    if (relevantCharacters.length > 0) {
        const charactersText = formatCharactersText(true);
        if (charactersText) {
            text += `[등장인물 정보]\n`;
            text += charactersText + "\n";
        }
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
