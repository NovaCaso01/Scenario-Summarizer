/**
 * 시나리오 자동요약 - UI 관련 함수
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { 
    extensionName, defaultSettings, 
    DEFAULT_PROMPT_TEMPLATE, 
    DEFAULT_BATCH_PROMPT_TEMPLATE,
    DEFAULT_CHARACTER_PROMPT_TEMPLATE
} from './constants.js';
import { log, getSettings, requestStop, isSummarizing, getErrorLogs, getLastError, clearErrorLogs, logError } from './state.js';
import { 
    getSummaryData, saveSummaryData, getRelevantSummaries, 
    setSummaryForMessage, deleteSummaryForMessage, clearAllSummaries,
    exportSummaries, importSummaries, searchSummaries, getCharacterName,
    getCharacters, getCharacter, setCharacter, deleteCharacter, 
    formatCharactersText, mergeExtractedCharacters, cleanupOrphanedSummaries
} from './storage.js';
import { runSummary, resummarizeMessage } from './summarizer.js';
import { applyMessageVisibility, restoreAllVisibility, getVisibilityStats } from './visibility.js';
import { injectSummaryToPrompt, clearInjection, getInjectionPreview } from './injection.js';
import { updateEventListeners } from './events.js';
import { loadModels, testApiConnection, getApiStatus } from './api.js';

// 현재 페이지 (페이지네이션)
let currentPage = 0;
const ITEMS_PER_PAGE = 10;

// 토큰 카운터 함수 (동적 로드)
let getTokenCountAsync = null;

/**
 * 토큰 카운터 함수 초기화
 */
export async function initTokenCounter() {
    if (getTokenCountAsync) return;
    
    try {
        // tokenizers.js에서 getTokenCountAsync 함수를 동적으로 import
        // 상대 경로를 절대 경로로 변경
        const tokenizersModule = await import('/scripts/tokenizers.js');
        getTokenCountAsync = tokenizersModule.getTokenCountAsync;
        console.log(`[${extensionName}] Token counter initialized successfully`);
    } catch (e) {
        console.warn(`[${extensionName}] Failed to load tokenizers module:`, e);
        // 폴백: 간단한 추정 함수
        getTokenCountAsync = async (text) => {
            const koreanChars = (text.match(/[\u3131-\uD79D]/g) || []).length;
            const otherChars = text.length - koreanChars;
            return Math.ceil(koreanChars / 2 + otherChars / 4);
        };
    }
}

/**
 * 토큰 카운터 함수 가져오기 (외부 모듈에서 사용)
 * @returns {Function|null}
 */
export function getTokenCounter() {
    return getTokenCountAsync;
}

/**
 * 설정 저장
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * HTML 이스케이프
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 주입 깊이 설정 표시/숨김
 */
function toggleInjectionDepthVisibility() {
    const position = $("#summarizer-injection-position").val();
    if (position === "in-chat") {
        $("#injection-depth-container").show();
    } else {
        $("#injection-depth-container").hide();
    }
}

/**
 * 토스트 메시지
 * @param {string} type - 'success', 'warning', 'error', 'info'
 * @param {string} message - 표시할 메시지
 * @param {Object} options - 추가 옵션 { error, context }
 */
function showToast(type, message, options = {}) {
    // 에러인 경우 로그에 기록
    if (type === 'error' && options.error) {
        logError(options.context || 'UI', options.error, options.details || {});
        // 에러 로그 확인 안내 추가
        message += ' (상태 탭 → 에러 로그에서 자세한 내용 확인 가능)';
    }
    
    if (typeof toastr !== 'undefined' && toastr[type]) {
        // 에러일 경우 더 오래 표시
        const toastOptions = type === 'error' ? { timeOut: 7000, extendedTimeOut: 3000 } : {};
        toastr[type](message, '시나리오 요약', toastOptions);
    } else {
        console.log(`[${extensionName}] ${type}: ${message}`);
    }
}

/**
 * 요약 컨텍스트 카운트 UI 업데이트
 * @param {number} value - 컨텍스트 카운트 값 (-1: 전체, 0: 없음, 1+: 개수)
 */
function updateContextCountDisplay(value) {
    const $range = $("#summarizer-context-range");
    const $count = $("#summarizer-context-count");
    const $all = $("#summarizer-context-all");
    
    if (value === -1) {
        $all.prop("checked", true);
        $range.prop("disabled", true);
        $count.prop("disabled", true);
    } else {
        $all.prop("checked", false);
        $range.prop("disabled", false);
        $count.prop("disabled", false);
        $range.val(Math.min(value, 50));
        $count.val(value);
    }
}

/**
 * execCommand를 사용한 클립보드 복사 폴백
 * @param {string} text - 복사할 텍스트
 * @returns {boolean} - 성공 여부
 */
function copyTextFallback(text) {
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        return success;
    } catch (e) {
        return false;
    }
}

// ===== 팝업 관리 =====

/**
 * UI 테마 적용
 * @param {string} theme - 테마 이름 ('mono-gray', 'dusty-rose', 'ocean-breeze', 'matcha-garden')
 */
function applyUITheme(theme) {
    const $popup = $("#scenario-summarizer-popup");
    $popup.attr("data-theme", theme || "mono-gray");
    log(`UI theme applied: ${theme || "mono-gray"}`);
}

/**
 * 팝업 열기
 */
export function openPopup() {
    updateUIFromSettings();
    
    // 테마 적용
    const settings = getSettings();
    applyUITheme(settings.uiTheme);
    updateStatusDisplay();
    updateApiDisplay();
    $("#scenario-summarizer-popup").addClass("open");
}

/**
 * 팝업 닫기
 */
export function closePopup() {
    $("#scenario-summarizer-popup").removeClass("open");
    closePreview();
}

// ===== 설정 UI =====

/**
 * 설정에서 UI 업데이트
 */
export function updateUIFromSettings() {
    const settings = getSettings();
    
    // 기본 설정
    $("#summarizer-enabled").prop("checked", settings.enabled);
    $("#summarizer-automatic").prop("checked", settings.automaticMode);
    $("#summarizer-interval").val(settings.summaryInterval);
    $("#summarizer-batch-size").val(settings.batchSize || 10);
    $("#summarizer-preserve").val(settings.preserveRecentMessages);
    
    // Auto-Hide
    $("#summarizer-auto-hide").prop("checked", settings.autoHideEnabled);
    
    // 월드인포 포함
    $("#summarizer-include-worldinfo").prop("checked", settings.includeWorldInfo !== false);
    
    // 등장인물 추적
    $("#summarizer-character-tracking").prop("checked", settings.characterTrackingEnabled !== false);
    
    // 주입 위치 설정
    $("#summarizer-injection-position").val(settings.injectionPosition || "in-chat");
    $("#summarizer-injection-depth").val(settings.injectionDepth !== undefined ? settings.injectionDepth : 0);
    toggleInjectionDepthVisibility();
    
    // 토큰 예산
    $("#summarizer-token-budget").val(settings.tokenBudget || 20000);
    
    // 요약 컨텍스트 (이전 요약 참조 수)
    const contextCount = settings.summaryContextCount !== undefined ? settings.summaryContextCount : 5;
    updateContextCountDisplay(contextCount);
    
    // 요약 모드
    const summaryMode = settings.summaryMode || "individual";
    $(`input[name='summary-mode'][value='${summaryMode}']`).prop("checked", true);
    $("#summarizer-batch-group-size").val(settings.batchGroupSize || 10);
    $("#summarizer-language").val(settings.summaryLanguage || "ko");
    $("#summarizer-ui-theme").val(settings.uiTheme || "mono-gray");
    toggleSummaryModeOptions();
    
    // 카테고리 (새 구조로 마이그레이션 및 렌더링)
    migrateCategories(settings);
    renderCategoryList();
    
    // API 설정
    $(`input[name='api-source'][value='${settings.apiSource}']`).prop("checked", true);
    $("#summarizer-use-raw").prop("checked", settings.useRawPrompt);
    $("#summarizer-custom-url").val(settings.customApiUrl);
    $("#summarizer-custom-key").val(settings.customApiKey);
    $("#summarizer-custom-max-tokens").val(settings.customApiMaxTokens || 4000);
    $("#summarizer-custom-timeout").val(settings.customApiTimeout || 60);
    
    toggleCustomApiSection();
    toggleSummaryModeOptions();
    
    // SillyTavern Connection Profile 로드
    populateConnectionProfiles();
    
    // 커스텀 API 프리셋 로드
    populateApiPresets();
    
    // 커스텀 프롬프트 (3개 타입)
    const promptTemplate = settings.customPromptTemplate || DEFAULT_PROMPT_TEMPLATE;
    $("#summarizer-prompt-template").val(promptTemplate);
    
    const batchPromptTemplate = settings.customBatchPromptTemplate || DEFAULT_BATCH_PROMPT_TEMPLATE;
    $("#summarizer-batch-prompt-template").val(batchPromptTemplate);
    
    const characterPromptTemplate = settings.customCharacterPromptTemplate || DEFAULT_CHARACTER_PROMPT_TEMPLATE;
    $("#summarizer-character-prompt-template").val(characterPromptTemplate);
    
    // 프롬프트 프리셋 로드
    populatePromptPresets();
}

/**
 * 커스텀 API 섹션 토글
 */
function toggleCustomApiSection() {
    const settings = getSettings();
    if (settings.apiSource === 'custom') {
        $("#custom-api-section").show();
        $("#sillytavern-api-options").hide();
    } else {
        $("#custom-api-section").hide();
        $("#sillytavern-api-options").show();
    }
}

/**
 * 요약 모드 옵션 토글
 */
function toggleSummaryModeOptions() {
    const mode = $("input[name='summary-mode']:checked").val();
    if (mode === 'batch') {
        $("#batch-mode-options").show();
        $("#batch-group-size-container").show();
    } else {
        $("#batch-mode-options").hide();
        $("#batch-group-size-container").hide();
    }
}

/**
 * SillyTavern Connection Manager 프로필 로드
 */
function populateConnectionProfiles() {
    const settings = getSettings();
    const $select = $("#summarizer-st-profile");
    
    // 요소가 없으면 스킵
    if ($select.length === 0) return;
    
    $select.empty();
    $select.append('<option value="">현재 연결 사용</option>');
    
    // SillyTavern의 extension_settings에서 connectionManager 프로필 가져오기
    try {
        const cmSettings = extension_settings?.connectionManager;
        let profiles = cmSettings?.profiles;
        
        // 배열인지 확인
        if (!Array.isArray(profiles)) {
            profiles = [];
        }
        
        for (const profile of profiles) {
            if (profile && profile.id && profile.name) {
                const selected = profile.id === settings.stConnectionProfile ? 'selected' : '';
                $select.append(`<option value="${profile.id}" ${selected}>${profile.name}</option>`);
            }
        }
        
        if (profiles.length > 0) {
            log(`Loaded ${profiles.length} connection profiles`);
        }
    } catch (error) {
        log(`Failed to load connection profiles: ${error.message}`);
    }
}

/**
 * 커스텀 API 프리셋 로드
 */
function populateApiPresets() {
    const settings = getSettings();
    
    // 배열인지 확인하고 아니면 빈 배열로 초기화
    let presets = settings.apiPresets;
    if (!Array.isArray(presets)) {
        presets = [];
        settings.apiPresets = presets;
    }
    
    const $select = $("#summarizer-preset-select");
    
    // 요소가 없으면 스킵 (커스텀 API 모드가 아닐 수 있음)
    if ($select.length === 0) return;
    
    $select.empty();
    $select.append('<option value="">-- 새 설정 --</option>');
    
    for (const preset of presets) {
        if (preset && preset.name) {
            const selected = preset.name === settings.selectedPreset ? 'selected' : '';
            $select.append(`<option value="${preset.name}" ${selected}>${preset.name}</option>`);
        }
    }
    
    // 현재 모델 선택 상태 복원
    if (settings.customApiModel) {
        const $modelSelect = $("#summarizer-custom-model");
        if ($modelSelect.length === 0) return;
        
        // 모델이 이미 로드되어 있으면 선택
        if ($modelSelect.find(`option[value="${settings.customApiModel}"]`).length > 0) {
            $modelSelect.val(settings.customApiModel);
        } else {
            // 없으면 옵션 추가
            $modelSelect.append(`<option value="${settings.customApiModel}" selected>${settings.customApiModel}</option>`);
        }
    }
}

/**
 * 프리셋 저장
 */
export function saveApiPreset() {
    const settings = getSettings();
    const name = $("#summarizer-preset-name").val().trim();
    
    if (!name) {
        showToast('warning', '프리셋 이름을 입력하세요.');
        return;
    }
    
    const url = $("#summarizer-custom-url").val().trim();
    const key = $("#summarizer-custom-key").val();
    const model = $("#summarizer-custom-model").val();
    
    if (!url || !model) {
        showToast('warning', 'API URL과 모델을 설정해주세요.');
        return;
    }
    
    // 프리셋 배열 초기화
    if (!settings.apiPresets) {
        settings.apiPresets = [];
    }
    
    // 기존 프리셋 찾기
    const existingIndex = settings.apiPresets.findIndex(p => p.name === name);
    
    const preset = { name, url, key, model };
    
    if (existingIndex >= 0) {
        // 기존 프리셋 업데이트
        settings.apiPresets[existingIndex] = preset;
        showToast('success', `프리셋 "${name}"이(가) 업데이트되었습니다.`);
    } else {
        // 새 프리셋 추가
        settings.apiPresets.push(preset);
        showToast('success', `프리셋 "${name}"이(가) 저장되었습니다.`);
    }
    
    settings.selectedPreset = name;
    saveSettings();
    populateApiPresets();
}

/**
 * 프리셋 삭제
 */
export function deleteApiPreset() {
    const settings = getSettings();
    const name = $("#summarizer-preset-select").val();
    
    if (!name) {
        showToast('warning', '삭제할 프리셋을 선택하세요.');
        return;
    }
    
    if (!confirm(`프리셋 "${name}"을(를) 삭제하시겠습니까?`)) {
        return;
    }
    
    settings.apiPresets = (settings.apiPresets || []).filter(p => p.name !== name);
    
    if (settings.selectedPreset === name) {
        settings.selectedPreset = '';
    }
    
    saveSettings();
    populateApiPresets();
    
    // UI 초기화
    $("#summarizer-custom-url").val('');
    $("#summarizer-custom-key").val('');
    $("#summarizer-custom-model").val('');
    $("#summarizer-preset-name").val('');
    
    showToast('success', `프리셋 "${name}"이(가) 삭제되었습니다.`);
}

/**
 * 프리셋 선택 시 로드
 */
export function loadSelectedPreset() {
    const settings = getSettings();
    const name = $("#summarizer-preset-select").val();
    
    if (!name) {
        // 새 설정 모드
        $("#summarizer-custom-url").val('');
        $("#summarizer-custom-key").val('');
        $("#summarizer-custom-model").empty().append('<option value="">모델 로드 필요</option>');
        $("#summarizer-preset-name").val('');
        return;
    }
    
    const preset = (settings.apiPresets || []).find(p => p.name === name);
    
    if (preset) {
        $("#summarizer-custom-url").val(preset.url || '');
        $("#summarizer-custom-key").val(preset.key || '');
        $("#summarizer-preset-name").val(preset.name);
        
        // 모델 설정
        const $modelSelect = $("#summarizer-custom-model");
        if (preset.model) {
            if ($modelSelect.find(`option[value="${preset.model}"]`).length === 0) {
                $modelSelect.append(`<option value="${preset.model}">${preset.model}</option>`);
            }
            $modelSelect.val(preset.model);
        }
        
        settings.selectedPreset = name;
        saveSettings();
    }
}

/**
 * API 상태 표시 업데이트
 */
export function updateApiDisplay() {
    const status = getApiStatus();
    const $display = $("#current-api-display");
    
    if (status.connected) {
        $display.html(`
            <div class="api-status-connected">
                <i class="fa-solid fa-plug-circle-check"></i>
                <span>${status.source === 'sillytavern' ? 'SillyTavern' : '커스텀'}: <strong>${status.displayName}</strong></span>
            </div>
        `);
    } else {
        $display.html(`
            <div class="api-status-disconnected">
                <i class="fa-solid fa-plug-circle-xmark"></i>
                <span>연결 안됨</span>
            </div>
        `);
    }
}

/**
 * 상태 표시 업데이트
 */
export function updateStatusDisplay() {
    const context = getContext();
    const data = getSummaryData();
    const stats = getVisibilityStats();
    
    const totalMessages = context?.chat?.length || 0;
    
    // 메시지 범위를 벗어난 고아 요약 정리 (메시지 삭제 시)
    cleanupOrphanedSummaries();
    
    const summaries = getRelevantSummaries();
    
    // 현재 채팅 범위 내에 있는 요약만 카운트
    let summarizedCount = 0;
    for (const indexStr of Object.keys(summaries)) {
        const index = parseInt(indexStr);
        if (index < totalMessages) {
            summarizedCount++;
        }
    }
    
    const pendingCount = Math.max(0, totalMessages - summarizedCount);
    
    const settings = getSettings();
    const interval = settings.summaryInterval || 10;
    const nextTrigger = Math.max(0, interval - pendingCount);
    
    $("#stat-total").text(totalMessages);
    $("#stat-summarized").text(summarizedCount);
    $("#stat-pending").text(pendingCount);
    $("#stat-hidden").text(stats.hidden);
    $("#stat-next-trigger").text(nextTrigger > 0 ? nextTrigger : "곧!");
}

// ===== 요약 실행 =====

/**
 * 수동 요약 실행
 */
export async function runManualSummary() {
    if (isSummarizing()) {
        showToast('warning', '이미 요약 중입니다.');
        return;
    }
    
    const useCustomRange = $("#summarizer-custom-range").prop("checked");
    
    let startIndex = null;
    let endIndex = null;
    
    if (useCustomRange) {
        const context = getContext();
        const totalMessages = context?.chat?.length || 0;
        
        const startInput = $("#summarizer-range-start").val().trim();
        const endInput = $("#summarizer-range-end").val().trim();
        
        // 0-indexed: 사용자가 입력한 값을 그대로 사용
        startIndex = startInput ? parseInt(startInput) : 0;
        endIndex = endInput ? parseInt(endInput) : totalMessages - 1;
        
        if (isNaN(startIndex) || isNaN(endIndex) || startIndex < 0 || endIndex < startIndex || endIndex >= totalMessages) {
            showToast('warning', `올바른 범위를 입력하세요. (0 ~ ${totalMessages - 1})`);
            return;
        }
    }
    
    showProgress(true);
    showToast('info', '요약을 시작합니다...');
    
    const result = await runSummary(startIndex, endIndex, (current, total) => {
        updateProgress(current, total);
    });
    
    showProgress(false);
    
    if (result.success) {
        showToast('success', `요약 완료! ${result.processed}개 메시지 처리됨`);
    } else if (result.error === '중단됨') {
        showToast('warning', '요약이 중단되었습니다.');
    } else {
        showToast('error', result.error || '요약 실패');
    }
    
    updateStatusDisplay();
}

/**
 * 요약 중단
 */
export function stopSummary() {
    requestStop();
    $("#summarizer-stop").prop("disabled", true).text("중단 중...");
    showToast('info', '요약을 중단합니다...');
}

/**
 * 진행 표시
 */
function showProgress(show) {
    if (show) {
        $("#summarizer-progress").show();
        $("#summarizer-stop").show().prop("disabled", false).html('<i class="fa-solid fa-stop"></i> 중단');
        $("#summarizer-run-now").prop("disabled", true);
    } else {
        $("#summarizer-progress").hide();
        $("#summarizer-stop").hide();
        $("#summarizer-run-now").prop("disabled", false);
    }
}

/**
 * 진행률 업데이트
 */
function updateProgress(current, total) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    $("#summarizer-progress-fill").css("width", `${percent}%`);
    $("#summarizer-progress-text").text(`${current} / ${total} 메시지 처리 중... (${percent}%)`);
}

// ===== 요약 보기/수정 =====

/**
 * 요약 목록 보기
 */
export async function viewSummaries() {
    currentPage = 0;
    await renderSummaryList();
    $("#summarizer-preview").show();
}

/**
 * 요약 목록 렌더링
 */
async function renderSummaryList() {
    const summaries = getRelevantSummaries();
    const allIndices = Object.keys(summaries).map(Number).sort((a, b) => b - a); // 최신순
    
    // 그룹 요약에 포함된 항목은 목록에서 제외
    const indices = allIndices.filter(index => {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        return !content.startsWith('[→') && !content.includes('그룹 요약에 포함');
    });
    
    const $content = $("#summarizer-preview-content");
    const $pagination = $("#summarizer-pagination");
    
    if (indices.length === 0) {
        $content.html('<p class="summarizer-placeholder">저장된 요약이 없습니다.</p>');
        $pagination.hide();
        return;
    }
    
    // 페이지네이션
    const totalPages = Math.ceil(indices.length / ITEMS_PER_PAGE);
    const startIdx = currentPage * ITEMS_PER_PAGE;
    const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, indices.length);
    const pageIndices = indices.slice(startIdx, endIdx);
    
    // 토큰 카운터 초기화
    await initTokenCounter();
    
    // 전체 토큰 계산 (SillyTavern의 토큰 카운터 사용)
    // 모든 요약 내용을 하나의 텍스트로 합치기
    let allContent = '';
    for (const index of allIndices) {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        if (!content.startsWith('[→') && !content.includes('그룹 요약에 포함')) {
            allContent += content + '\n';
        }
    }
    
    // 전체 내용을 한 번에 계산
    let totalTokens = 0;
    if (allContent.length > 0) {
        totalTokens = await getTokenCountAsync(allContent);
    }
    
    let html = `<div class="summarizer-summary-header">
        <strong>${getCharacterName()} 시나리오 요약</strong>
        <small>총 ${indices.length}개 · ${totalTokens.toLocaleString()} 토큰</small>
    </div>`;
    
    for (const index of pageIndices) {
        const summary = summaries[index];
        const content = String(summary?.content ?? summary ?? '');
        const isInvalidated = summary?.invalidated === true;
        const invalidReason = summary?.invalidReason || '';
        
        // 날짜(요일) 포맷팅
        let dateDisplay = '';
        if (summary?.timestamp) {
            const date = new Date(summary.timestamp);
            const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const dayOfWeek = dayNames[date.getDay()];
            dateDisplay = `${month}/${day}(${dayOfWeek})`;
        }
        
        // 그룹 요약인 경우 번호 범위 표시 (0-indexed)
        const rangeMatch = content.match(/^#(\d+)-(\d+)/);
        let displayNumber = rangeMatch ? `#${rangeMatch[1]}~${rangeMatch[2]}` : `#${index}`;
        
        // 파싱 오류/불완전 요약 감지
        const hasParsingError = content.includes('파싱 실패') || content.includes('❌');
        const hasWarning = content.includes('불완전한') || content.includes('⚠️') || content.includes('재요약 권장');
        const errorClass = hasParsingError ? ' summarizer-entry-error' : (hasWarning ? ' summarizer-entry-warning' : '');
        const errorBadge = hasParsingError ? '<span class="summarizer-error-badge" title="파싱 오류 - 재요약 필요">❌ 오류</span>' : 
                          (hasWarning ? '<span class="summarizer-warning-badge" title="불완전한 요약 - 재요약 권장">⚠️ 불완전</span>' : '');
        
        // 무효화된 요약 스타일
        const invalidatedClass = isInvalidated ? ' summarizer-entry-invalidated' : '';
        const invalidatedBadge = isInvalidated ? `<span class="summarizer-invalidated-badge" title="${escapeHtml(invalidReason)}">⚠️ 무효화됨</span>` : '';
        
        // 표시용 content: 첫 줄의 헤더(#번호 또는 #번호-번호)는 제거 (UI에서 별도 표시)
        let displayContent = content;
        if (/^#\d+(-\d+)?\s*\n/.test(displayContent)) {
            displayContent = displayContent.replace(/^#\d+(-\d+)?\s*\n/, '');
        }
        
        html += `
        <div class="summarizer-entry${invalidatedClass}${errorClass}" data-msg-index="${index}">
            <div class="summarizer-entry-header">
                <span class="summarizer-entry-number">${displayNumber}${invalidatedBadge}${errorBadge}</span>
                ${dateDisplay ? `<span class="summarizer-entry-date">${dateDisplay}</span>` : ''}
                <div class="summarizer-entry-actions">
                    <button class="summarizer-btn summarizer-btn-tiny summarizer-edit-entry" data-idx="${index}" title="수정">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="summarizer-btn summarizer-btn-tiny summarizer-regenerate-entry" data-idx="${index}" title="재생성">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button class="summarizer-btn summarizer-btn-tiny summarizer-delete-entry" data-idx="${index}" title="삭제">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <pre class="summarizer-entry-content">${escapeHtml(displayContent)}</pre>
            <div class="summarizer-entry-edit-area" style="display:none;">
                <textarea class="summarizer-entry-textarea">${escapeHtml(content)}</textarea>
                <div class="summarizer-entry-edit-buttons">
                    <button class="summarizer-btn summarizer-btn-small summarizer-btn-success summarizer-save-entry" data-idx="${index}">
                        <i class="fa-solid fa-check"></i> 저장
                    </button>
                    <button class="summarizer-btn summarizer-btn-small summarizer-btn-secondary summarizer-cancel-entry" data-idx="${index}">
                        <i class="fa-solid fa-xmark"></i> 취소
                    </button>
                </div>
            </div>
        </div>`;
    }
    
    $content.html(html);
    
    // 페이지네이션 UI
    if (totalPages > 1) {
        $pagination.html(`
            <button class="summarizer-btn summarizer-btn-small" id="summarizer-prev-page" ${currentPage === 0 ? 'disabled' : ''}>
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            <span>${currentPage + 1} / ${totalPages}</span>
            <button class="summarizer-btn summarizer-btn-small" id="summarizer-next-page" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>
                <i class="fa-solid fa-chevron-right"></i>
            </button>
        `).show();
        
        // 페이지 직접 이동 UI 표시
        const $pageJump = $("#summarizer-page-jump");
        $pageJump.show();
        $("#summarizer-page-input").attr("max", totalPages).attr("placeholder", `1-${totalPages}`);
        
        $("#summarizer-prev-page").on("click", async () => {
            if (currentPage > 0) {
                currentPage--;
                await renderSummaryList();
            }
        });
        
        $("#summarizer-next-page").on("click", async () => {
            if (currentPage < totalPages - 1) {
                currentPage++;
                await renderSummaryList();
            }
        });
        
        // 페이지 직접 이동
        $("#summarizer-page-go").off("click").on("click", async () => {
            const inputVal = parseInt($("#summarizer-page-input").val());
            if (!isNaN(inputVal) && inputVal >= 1 && inputVal <= totalPages) {
                currentPage = inputVal - 1;
                await renderSummaryList();
            } else {
                showToast('warning', `1~${totalPages} 사이의 페이지를 입력하세요.`);
            }
        });
        
        // Enter 키로도 이동
        $("#summarizer-page-input").off("keydown").on("keydown", (e) => {
            if (e.key === 'Enter') {
                $("#summarizer-page-go").click();
            }
        });
    } else {
        $pagination.hide();
        $("#summarizer-page-jump").hide();
    }
    
    // 이벤트 바인딩
    bindEntryEvents();
}

/**
 * 개별 항목 이벤트 바인딩
 */
function bindEntryEvents() {
    // 수정
    $(".summarizer-edit-entry").off("click").on("click", function() {
        const idx = $(this).data("idx");
        const $entry = $(`.summarizer-entry[data-msg-index="${idx}"]`);
        $entry.find(".summarizer-entry-content").hide();
        $entry.find(".summarizer-entry-edit-area").show();
    });
    
    // 저장
    $(".summarizer-save-entry").off("click").on("click", async function() {
        const idx = $(this).data("idx");
        const $entry = $(`.summarizer-entry[data-msg-index="${idx}"]`);
        const newContent = $entry.find(".summarizer-entry-textarea").val();
        
        setSummaryForMessage(idx, newContent);
        await saveSummaryData();
        await injectSummaryToPrompt();
        
        showToast('success', `#${idx} 요약이 수정되었습니다.`);
        await renderSummaryList();
    });
    
    // 취소
    $(".summarizer-cancel-entry").off("click").on("click", function() {
        const idx = $(this).data("idx");
        const $entry = $(`.summarizer-entry[data-msg-index="${idx}"]`);
        $entry.find(".summarizer-entry-content").show();
        $entry.find(".summarizer-entry-edit-area").hide();
    });
    
    // 재생성
    $(".summarizer-regenerate-entry").off("click").on("click", async function() {
        const idx = parseInt($(this).data("idx"));
        const summaries = getRelevantSummaries();
        const currentSummary = summaries[idx]?.content || "";
        
        // 그룹 요약인지 확인
        const groupPattern = /^#(\d+)-(\d+)/;
        const groupMatch = groupPattern.exec(currentSummary);
        const includedPattern = /\[→ #(\d+)-(\d+) 그룹 요약에 포함\]/;
        const includedMatch = includedPattern.exec(currentSummary);
        
        let confirmMessage;
        if (groupMatch) {
            confirmMessage = `#${groupMatch[1]}-${groupMatch[2]} 그룹 요약을 재생성하시겠습니까?`;
        } else if (includedMatch) {
            confirmMessage = `#${includedMatch[1]}-${includedMatch[2]} 그룹 요약을 재생성하시겠습니까?`;
        } else {
            confirmMessage = `#${idx} 요약을 재생성하시겠습니까?`;
        }
        
        if (!confirm(confirmMessage)) return;
        
        showToast('info', '재생성 중...');
        const result = await resummarizeMessage(idx);
        
        if (result.success) {
            const successMsg = result.startIdx !== undefined && result.startIdx !== result.endIdx
                ? `#${result.startIdx}-${result.endIdx} 그룹 요약이 재생성되었습니다.`
                : `#${idx} 요약이 재생성되었습니다.`;
            showToast('success', successMsg);
            await renderSummaryList();
        } else {
            showToast('error', result.error || '재생성 실패');
        }
    });
    
    // 삭제
    $(".summarizer-delete-entry").off("click").on("click", async function() {
        const idx = $(this).data("idx");
        
        if (!confirm(`#${idx} 요약을 삭제하시겠습니까?`)) return;
        
        deleteSummaryForMessage(idx);
        await saveSummaryData();
        await injectSummaryToPrompt();
        applyMessageVisibility();
        
        showToast('success', `#${idx} 요약이 삭제되었습니다.`);
        await renderSummaryList();
        updateStatusDisplay();
    });
}

/**
 * 미리보기 닫기
 */
export function closePreview() {
    $("#summarizer-preview").hide();
}

// ===== 검색 =====

/**
 * 요약 검색
 */
export function doSearch() {
    const query = $("#summarizer-search-input").val().trim();
    
    if (!query) {
        showToast('warning', '검색어를 입력하세요.');
        return;
    }
    
    const results = searchSummaries(query);
    
    if (results.length === 0) {
        showToast('info', '검색 결과가 없습니다.');
        return;
    }
    
    // 검색 결과 표시
    const $content = $("#summarizer-preview-content");
    
    let html = `<div class="summarizer-summary-header">
        <strong>검색 결과: "${escapeHtml(query)}"</strong>
        <small>${results.length}개 발견</small>
    </div>`;
    
    for (const result of results) {
        // 표시용 content: 첫 줄의 헤더 제거
        let displayContent = result.content;
        if (/^#\d+(-\d+)?\s*\n/.test(displayContent)) {
            displayContent = displayContent.replace(/^#\d+(-\d+)?\s*\n/, '');
        }
        
        const highlighted = displayContent.replace(
            new RegExp(escapeHtml(query), 'gi'),
            match => `<mark>${match}</mark>`
        );
        
        // 그룹 요약인 경우 번호 범위 표시
        const rangeMatch = result.content.match(/^#(\d+)-(\d+)/);
        const displayNumber = rangeMatch ? `#${rangeMatch[1]}~${rangeMatch[2]}` : `#${result.messageIndex}`;
        
        html += `
        <div class="summarizer-entry" data-msg-index="${result.messageIndex}">
            <div class="summarizer-entry-header">
                <span class="summarizer-entry-number">${displayNumber}</span>
            </div>
            <pre class="summarizer-entry-content">${highlighted}</pre>
        </div>`;
    }
    
    $content.html(html);
    $("#summarizer-preview").show();
    $("#summarizer-pagination").hide();
    $("#summarizer-page-jump").hide();
}

// ===== 내보내기/가져오기 =====

/**
 * 요약 내보내기
 */
export function doExport() {
    const json = exportSummaries();
    
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scenario-summary-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('success', '요약이 내보내졌습니다.');
}

/**
 * 요약 가져오기
 */
export function doImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const success = importSummaries(text);
            
            if (success) {
                await saveSummaryData();
                await injectSummaryToPrompt();
                applyMessageVisibility();
                updateStatusDisplay();
                showToast('success', '요약을 가져왔습니다.');
            } else {
                showToast('error', '가져오기 실패: 잘못된 형식');
            }
        } catch (error) {
            showToast('error', `가져오기 실패: ${error.message}`);
        }
    };
    
    input.click();
}

// ===== 초기화 =====

/**
 * 숨김 해제 (모든 메시지 표시)
 */
export function doRestoreVisibility() {
    restoreAllVisibility();
    updateStatusDisplay();
    showToast('success', '모든 메시지가 다시 표시됩니다.');
}

/**
 * 요약 초기화
 */
export async function doReset() {
    if (!confirm('정말 이 채팅의 모든 요약과 등장인물을 삭제하시겠습니까?')) {
        return;
    }
    
    // 등장인물도 함께 초기화하려면 먼저 비운 후 clearAllSummaries 호출
    const summaryData = getSummaryData();
    if (summaryData) {
        summaryData.characters = {};
    }
    
    clearAllSummaries();
    
    await saveSummaryData();
    restoreAllVisibility();
    clearInjection();
    updateStatusDisplay();
    renderCharactersList();
    
    showToast('success', '요약과 등장인물이 초기화되었습니다.');
}

/**
 * 요약만 초기화 (등장인물 유지)
 */
export async function doResetSummariesOnly() {
    if (!confirm('정말 이 채팅의 모든 요약을 삭제하시겠습니까?\n(등장인물 정보는 유지됩니다)')) {
        return;
    }
    
    clearAllSummaries();
    await saveSummaryData();
    restoreAllVisibility();
    clearInjection();
    updateStatusDisplay();
    
    showToast('success', '요약이 초기화되었습니다.');
}

// ===== 카테고리 관리 =====

/**
 * 구버전 카테고리 구조를 새 구조로 마이그레이션
 */
function migrateCategories(settings) {
    if (!settings.categories) {
        settings.categories = {};
    }
    
    // defaultSettings.categories를 사용하여 일관성 유지
    const defaultCategories = defaultSettings.categories;
    
    // 각 카테고리 확인 및 마이그레이션
    for (const [key, defaultValue] of Object.entries(defaultCategories)) {
        const current = settings.categories[key];
        
        // 불리언이거나 없으면 마이그레이션
        if (typeof current === 'boolean' || current === undefined) {
            settings.categories[key] = {
                ...defaultValue,
                enabled: current === true || (key === 'scenario') // scenario는 항상 활성화
            };
        }
        // 객체지만 필드가 누락된 경우 채우기
        else if (typeof current === 'object') {
            // 기본값을 기반으로 하되, enabled와 prompt는 기존 값 유지
            settings.categories[key] = {
                ...defaultValue,
                enabled: current.enabled !== undefined ? current.enabled : defaultValue.enabled,
                prompt: current.prompt !== undefined ? current.prompt : defaultValue.prompt
            };
        }
    }
    
    // dialogue가 있으면 제거 (시나리오에 통합됨)
    delete settings.categories.dialogue;
    
    saveSettings();
}

/**
 * 카테고리 순서 배열 초기화 (없으면 기본값으로)
 */
function ensureCategoryOrder(settings) {
    if (!settings.categoryOrder || !Array.isArray(settings.categoryOrder)) {
        settings.categoryOrder = [...defaultSettings.categoryOrder];
    }
    return settings.categoryOrder;
}

/**
 * 카테고리 순서 가져오기 (설정에 저장된 순서 + 새 카테고리 추가)
 */
function getCategoryOrder(settings) {
    const cats = settings.categories || {};
    const allKeys = Object.keys(cats).filter(key => typeof cats[key] === 'object');
    
    // 저장된 순서가 없으면 기본 순서 사용
    ensureCategoryOrder(settings);
    
    // 저장된 순서에 있는 키들 (유효한 것만)
    const orderedKeys = settings.categoryOrder.filter(key => allKeys.includes(key));
    
    // 순서에 없는 새 키들 추가
    const newKeys = allKeys.filter(key => !orderedKeys.includes(key));
    
    return [...orderedKeys, ...newKeys];
}

/**
 * 카테고리 리스트 렌더링
 */
function renderCategoryList() {
    const settings = getSettings();
    const cats = settings.categories || {};
    const $list = $("#summarizer-category-list");
    
    $list.empty();
    
    // 순서대로 렌더링
    const orderedKeys = getCategoryOrder(settings);
    
    for (const key of orderedKeys) {
        const cat = cats[key];
        if (!cat || typeof cat !== 'object') continue;
        
        const isScenario = key === 'scenario';
        const enabled = cat.enabled;
        // 기본값과 현재 값이 다른지 확인 (수정된 상태)
        const defaultCat = defaultSettings.categories[key];
        const isModified = defaultCat && cat.prompt !== defaultCat.prompt;
        
        const html = `
            <div class="summarizer-category-item ${enabled ? '' : 'disabled'}" data-key="${key}" draggable="true">
                <div class="summarizer-category-header">
                    <span class="summarizer-category-drag-handle" title="드래그하여 순서 변경">
                        <i class="fa-solid fa-grip-vertical"></i>
                    </span>
                    <span class="summarizer-category-icon">${cat.icon || '📝'}</span>
                    <span class="summarizer-category-label">${cat.label || key}</span>
                    ${isScenario ? '<span class="summarizer-category-required">필수</span>' : ''}
                    ${isModified ? '<span class="summarizer-category-modified">수정됨</span>' : ''}
                    <div class="summarizer-category-actions">
                        ${defaultCat ? `
                            <button class="reset-btn" title="기본값으로 초기화">
                                <i class="fa-solid fa-rotate-left"></i>
                            </button>
                        ` : ''}
                        ${!isScenario ? `
                            <button class="toggle-btn" title="${enabled ? '비활성화' : '활성화'}">
                                <i class="fa-solid ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                            </button>
                        ` : ''}
                        ${!isScenario ? `
                            <button class="delete-btn" title="삭제">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
                <div class="summarizer-category-prompt" data-key="${key}">${cat.prompt || '(프롬프트 없음)'}</div>
            </div>
        `;
        
        $list.append(html);
    }
    
    // 이벤트 바인딩
    bindCategoryEvents();
    bindCategoryDragEvents();
}

/**
 * 드래그 앤 드롭 이벤트 바인딩
 */
function bindCategoryDragEvents() {
    const $list = $("#summarizer-category-list");
    const items = $list.find(".summarizer-category-item");
    
    let draggedItem = null;
    
    items.each(function() {
        const item = this;
        
        // 드래그 시작
        item.addEventListener("dragstart", function(e) {
            draggedItem = this;
            this.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", $(this).data("key"));
        });
        
        // 드래그 종료
        item.addEventListener("dragend", function() {
            this.classList.remove("dragging");
            draggedItem = null;
            // 모든 아이템에서 드래그 오버 스타일 제거
            items.removeClass("drag-over");
        });
        
        // 드래그 오버 (다른 아이템 위에 있을 때)
        item.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            
            if (draggedItem && draggedItem !== this) {
                this.classList.add("drag-over");
            }
        });
        
        // 드래그 리브 (다른 아이템에서 벗어날 때)
        item.addEventListener("dragleave", function() {
            this.classList.remove("drag-over");
        });
        
        // 드롭
        item.addEventListener("drop", function(e) {
            e.preventDefault();
            this.classList.remove("drag-over");
            
            if (draggedItem && draggedItem !== this) {
                const draggedKey = $(draggedItem).data("key");
                const targetKey = $(this).data("key");
                
                // 순서 변경
                reorderCategory(draggedKey, targetKey);
            }
        });
    });
}

/**
 * 카테고리 순서 변경
 */
function reorderCategory(draggedKey, targetKey) {
    const settings = getSettings();
    
    // 현재 순서 가져오기
    const order = getCategoryOrder(settings);
    
    // 드래그된 아이템의 인덱스
    const draggedIndex = order.indexOf(draggedKey);
    const targetIndex = order.indexOf(targetKey);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    if (draggedIndex === targetIndex) return;
    
    // 드래그된 아이템 제거
    order.splice(draggedIndex, 1);
    
    // 타겟 위치 계산 (드래그된 아이템 제거 후 인덱스 조정)
    // draggedIndex < targetIndex인 경우, 제거 후 targetIndex가 1 감소함
    const insertIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
    
    // 타겟 위치에 삽입
    order.splice(insertIndex, 0, draggedKey);
    
    // 설정에 저장
    settings.categoryOrder = order;
    saveSettings();
    
    // 리스트 다시 렌더링
    renderCategoryList();
}

/**
 * 카테고리 이벤트 바인딩
 */
function bindCategoryEvents() {
    // 토글 버튼
    $(".summarizer-category-item .toggle-btn").off("click").on("click", function(e) {
        e.stopPropagation();
        const key = $(this).closest(".summarizer-category-item").data("key");
        toggleCategory(key);
    });
    
    // 삭제 버튼
    $(".summarizer-category-item .delete-btn").off("click").on("click", function(e) {
        e.stopPropagation();
        const key = $(this).closest(".summarizer-category-item").data("key");
        deleteCategory(key);
    });
    
    // 개별 초기화 버튼
    $(".summarizer-category-item .reset-btn").off("click").on("click", function(e) {
        e.stopPropagation();
        const key = $(this).closest(".summarizer-category-item").data("key");
        resetCategoryToDefault(key);
    });
    
    // 프롬프트 클릭 → 편집 모드
    $(".summarizer-category-prompt").off("click").on("click", function() {
        const key = $(this).data("key");
        editCategoryPrompt(key, $(this));
    });
}

/**
 * 카테고리 토글
 */
function toggleCategory(key) {
    const settings = getSettings();
    if (settings.categories[key]) {
        settings.categories[key].enabled = !settings.categories[key].enabled;
        saveSettings();
        renderCategoryList();
    }
}

/**
 * 카테고리 삭제
 */
function deleteCategory(key) {
    if (key === 'scenario') return;
    
    if (!confirm(`"${key}" 항목을 삭제하시겠습니까?`)) return;
    
    const settings = getSettings();
    delete settings.categories[key];
    
    // 순서 배열에서도 제거
    if (settings.categoryOrder && Array.isArray(settings.categoryOrder)) {
        settings.categoryOrder = settings.categoryOrder.filter(k => k !== key);
    }
    
    saveSettings();
    renderCategoryList();
    showToast('success', '항목이 삭제되었습니다.');
}

/**
 * 개별 카테고리 기본값으로 초기화
 */
function resetCategoryToDefault(key) {
    const defaultCat = defaultSettings.categories[key];
    if (!defaultCat) {
        showToast('error', '기본값이 없는 사용자 정의 항목입니다.');
        return;
    }
    
    const settings = getSettings();
    const currentCat = settings.categories[key];
    const label = currentCat?.label || key;
    
    if (!confirm(`"${label}" 항목을 기본값으로 초기화하시겠습니까?`)) return;
    
    // 기본값으로 복원 (enabled 상태는 유지)
    settings.categories[key] = {
        ...defaultCat,
        enabled: currentCat?.enabled !== undefined ? currentCat.enabled : defaultCat.enabled
    };
    
    saveSettings();
    renderCategoryList();
    showToast('success', `"${label}" 항목이 기본값으로 초기화되었습니다.`);
}

/**
 * 모든 카테고리 기본값으로 초기화
 */
function resetAllCategoriesToDefault() {
    if (!confirm('모든 요약 항목을 기본값으로 초기화하시겠습니까?\n(사용자가 추가한 커스텀 항목은 삭제됩니다)')) return;
    
    const settings = getSettings();
    
    // 기본 카테고리로 완전 교체
    settings.categories = {};
    for (const [key, defaultCat] of Object.entries(defaultSettings.categories)) {
        settings.categories[key] = { ...defaultCat };
    }
    
    // 순서도 기본값으로 초기화
    settings.categoryOrder = [...defaultSettings.categoryOrder];
    
    saveSettings();
    renderCategoryList();
    showToast('success', '모든 요약 항목이 기본값으로 초기화되었습니다.');
}

/**
 * 카테고리 프롬프트 편집
 */
function editCategoryPrompt(key, $promptEl) {
    const settings = getSettings();
    const cat = settings.categories[key];
    if (!cat) return;
    
    const currentPrompt = cat.prompt || '';
    
    // 이미 편집 중이면 무시
    if ($promptEl.find("textarea").length > 0) return;
    
    // 입력 필드로 교체
    const $input = $(`<textarea class="summarizer-category-prompt-input" rows="2">${currentPrompt}</textarea>`);
    $promptEl.hide().after($input);
    $input.focus().select();
    
    // blur 또는 Enter로 저장
    const savePrompt = () => {
        const newPrompt = $input.val().trim();
        settings.categories[key].prompt = newPrompt;
        saveSettings();
        $input.remove();
        $promptEl.text(newPrompt || '(프롬프트 없음)').show();
    };
    
    $input.on("blur", savePrompt);
    $input.on("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            savePrompt();
        }
        if (e.key === "Escape") {
            $input.remove();
            $promptEl.show();
        }
    });
}

/**
 * 새 카테고리 추가 폼 표시
 */
function showAddCategoryForm() {
    const $form = $(`
        <div class="summarizer-add-category-form active" id="add-category-form">
            <div class="summarizer-add-category-row">
                <div class="summarizer-add-category-row-inline">
                    <input type="text" class="summarizer-icon-input" id="new-cat-icon" placeholder="😊" maxlength="2" />
                    <input type="text" id="new-cat-label" placeholder="항목 이름 (예: 복선)" />
                </div>
                <input type="text" id="new-cat-prompt" placeholder="AI에게 전달할 지침 (예: 숨겨진 복선과 떡밥을 기록)" />
            </div>
            <div class="summarizer-add-category-buttons">
                <button id="save-new-category" class="summarizer-btn summarizer-btn-primary">
                    <i class="fa-solid fa-check"></i> 추가
                </button>
                <button id="cancel-new-category" class="summarizer-btn summarizer-btn-secondary">
                    <i class="fa-solid fa-xmark"></i> 취소
                </button>
            </div>
        </div>
    `);
    
    // 기존 폼 제거
    $("#add-category-form").remove();
    
    // 버튼 뒤에 추가
    $("#summarizer-add-category").after($form);
    $("#summarizer-add-category").hide();
    
    // 이벤트
    $("#save-new-category").on("click", saveNewCategory);
    $("#cancel-new-category").on("click", hideAddCategoryForm);
    $("#new-cat-label").focus();
}

/**
 * 새 카테고리 추가 폼 숨기기
 */
function hideAddCategoryForm() {
    $("#add-category-form").remove();
    $("#summarizer-add-category").show();
}

/**
 * 새 카테고리 저장
 */
function saveNewCategory() {
    const icon = $("#new-cat-icon").val().trim() || "📝";
    const label = $("#new-cat-label").val().trim();
    const prompt = $("#new-cat-prompt").val().trim();
    
    if (!label) {
        showToast('error', '항목 이름을 입력하세요.');
        return;
    }
    
    // key 생성 (영문 소문자, 공백은 언더스코어)
    const key = label.toLowerCase().replace(/[^a-z0-9가-힣]/g, '_').replace(/_+/g, '_');
    
    const settings = getSettings();
    if (settings.categories[key]) {
        showToast('error', '이미 존재하는 항목입니다.');
        return;
    }
    
    settings.categories[key] = {
        enabled: true,
        label: label,
        icon: icon,
        prompt: prompt || `${label} 관련 내용을 기록`
    };
    
    // 순서 배열에 추가
    ensureCategoryOrder(settings);
    if (!settings.categoryOrder.includes(key)) {
        settings.categoryOrder.push(key);
    }
    
    saveSettings();
    hideAddCategoryForm();
    renderCategoryList();
    showToast('success', `"${label}" 항목이 추가되었습니다.`);
}

// ===== 프롬프트 관리 =====

/**
 * 프롬프트 저장
 */
export function savePromptTemplate() {
    const settings = getSettings();
    const template = $("#summarizer-prompt-template").val();
    
    if (template.trim() === DEFAULT_PROMPT_TEMPLATE.trim()) {
        settings.customPromptTemplate = null;
    } else {
        settings.customPromptTemplate = template;
    }
    
    saveSettings();
    showToast('success', '개별 요약 프롬프트가 저장되었습니다.');
}

/**
 * 프롬프트 초기화
 */
export function resetPromptTemplate() {
    if (!confirm('개별 요약 프롬프트를 기본값으로 초기화하시겠습니까?')) {
        return;
    }
    
    const settings = getSettings();
    settings.customPromptTemplate = null;
    saveSettings();
    
    $("#summarizer-prompt-template").val(DEFAULT_PROMPT_TEMPLATE);
    showToast('success', '개별 요약 프롬프트가 초기화되었습니다.');
}

/**
 * 묶음 요약 프롬프트 저장
 */
export function saveBatchPromptTemplate() {
    const settings = getSettings();
    const template = $("#summarizer-batch-prompt-template").val();
    
    if (template.trim() === DEFAULT_BATCH_PROMPT_TEMPLATE.trim()) {
        settings.customBatchPromptTemplate = null;
    } else {
        settings.customBatchPromptTemplate = template;
    }
    
    saveSettings();
    showToast('success', '묶음 요약 프롬프트가 저장되었습니다.');
}

/**
 * 묶음 요약 프롬프트 초기화
 */
export function resetBatchPromptTemplate() {
    if (!confirm('묶음 요약 프롬프트를 기본값으로 초기화하시겠습니까?')) {
        return;
    }
    
    const settings = getSettings();
    settings.customBatchPromptTemplate = null;
    saveSettings();
    
    $("#summarizer-batch-prompt-template").val(DEFAULT_BATCH_PROMPT_TEMPLATE);
    showToast('success', '묶음 요약 프롬프트가 초기화되었습니다.');
}

/**
 * 등장인물 추출 프롬프트 저장
 */
export function saveCharacterPromptTemplate() {
    const settings = getSettings();
    const template = $("#summarizer-character-prompt-template").val();
    
    if (template.trim() === DEFAULT_CHARACTER_PROMPT_TEMPLATE.trim()) {
        settings.customCharacterPromptTemplate = null;
    } else {
        settings.customCharacterPromptTemplate = template;
    }
    
    saveSettings();
    showToast('success', '등장인물 추출 프롬프트가 저장되었습니다.');
}

/**
 * 등장인물 추출 프롬프트 초기화
 */
export function resetCharacterPromptTemplate() {
    if (!confirm('등장인물 추출 프롬프트를 기본값으로 초기화하시겠습니까?')) {
        return;
    }
    
    const settings = getSettings();
    settings.customCharacterPromptTemplate = null;
    saveSettings();
    
    $("#summarizer-character-prompt-template").val(DEFAULT_CHARACTER_PROMPT_TEMPLATE);
    showToast('success', '등장인물 추출 프롬프트가 초기화되었습니다.');
}

/**
 * 프롬프트 서브탭 전환
 */
function switchPromptSubtab(promptType) {
    // 모든 서브탭 비활성화
    $(".summarizer-prompt-subtab").removeClass("active");
    // 선택된 서브탭 활성화
    $(`.summarizer-prompt-subtab[data-prompt-type="${promptType}"]`).addClass("active");
    
    // 모든 섹션 숨기기
    $(".summarizer-prompt-section").hide();
    // 선택된 섹션 표시
    $(`#prompt-section-${promptType}`).show();
    
    // 프리셋 목록 갱신 (프롬프트 타입별)
    populatePromptPresets();
}

/**
 * 현재 활성화된 프롬프트 타입 반환
 */
function getCurrentPromptType() {
    const $active = $(".summarizer-prompt-subtab.active");
    return $active.length ? $active.data("prompt-type") : 'individual';
}

/**
 * 프롬프트 타입별 설정 키 및 기본값 반환
 */
function getPromptTypeConfig(promptType) {
    switch (promptType) {
        case 'batch':
            return {
                settingKey: 'customBatchPromptTemplate',
                presetKey: 'batchPromptPresets',
                selectedKey: 'selectedBatchPromptPreset',
                defaultTemplate: DEFAULT_BATCH_PROMPT_TEMPLATE,
                textareaId: '#summarizer-batch-prompt-template',
                label: '묶음 요약'
            };
        case 'character':
            return {
                settingKey: 'customCharacterPromptTemplate',
                presetKey: 'characterPromptPresets',
                selectedKey: 'selectedCharacterPromptPreset',
                defaultTemplate: DEFAULT_CHARACTER_PROMPT_TEMPLATE,
                textareaId: '#summarizer-character-prompt-template',
                label: '등장인물 추출'
            };
        default: // individual
            return {
                settingKey: 'customPromptTemplate',
                presetKey: 'promptPresets',
                selectedKey: 'selectedPromptPreset',
                defaultTemplate: DEFAULT_PROMPT_TEMPLATE,
                textareaId: '#summarizer-prompt-template',
                label: '개별 요약'
            };
    }
}

// ===== 프롬프트 프리셋 관리 =====

/**
 * 프롬프트 프리셋 목록 로드
 */
function populatePromptPresets() {
    const settings = getSettings();
    const promptType = getCurrentPromptType();
    const config = getPromptTypeConfig(promptType);
    const $select = $("#summarizer-prompt-preset-select");
    
    if ($select.length === 0) return;
    
    $select.empty();
    $select.append('<option value="">저장된 프리셋 없음</option>');
    
    let presets = settings[config.presetKey];
    if (!Array.isArray(presets)) {
        presets = [];
    }
    
    for (const preset of presets) {
        if (preset && preset.name) {
            $select.append(`<option value="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</option>`);
        }
    }
    
    // 현재 선택된 프리셋 표시
    if (settings[config.selectedKey]) {
        $select.val(settings[config.selectedKey]);
    }
}

/**
 * 프롬프트 프리셋 저장
 */
function savePromptPreset() {
    const settings = getSettings();
    const promptType = getCurrentPromptType();
    const config = getPromptTypeConfig(promptType);
    
    const name = $("#summarizer-prompt-preset-name").val().trim();
    const template = $(config.textareaId).val();
    
    if (!name) {
        showToast('error', '프리셋 이름을 입력하세요.');
        return;
    }
    
    if (!template.trim()) {
        showToast('error', '프롬프트를 입력하세요.');
        return;
    }
    
    if (!Array.isArray(settings[config.presetKey])) {
        settings[config.presetKey] = [];
    }
    
    // 기존 프리셋 확인
    const existingIdx = settings[config.presetKey].findIndex(p => p.name === name);
    if (existingIdx >= 0) {
        if (!confirm(`"${name}" 프리셋이 이미 존재합니다. 덮어쓰시겠습니까?`)) {
            return;
        }
        settings[config.presetKey][existingIdx].template = template;
    } else {
        settings[config.presetKey].push({ name, template });
    }
    
    settings[config.selectedKey] = name;
    saveSettings();
    populatePromptPresets();
    
    $("#summarizer-prompt-preset-name").val('');
    showToast('success', `${config.label} 프리셋 "${name}" 저장됨`);
}

/**
 * 프롬프트 프리셋 불러오기
 */
function loadPromptPreset() {
    const settings = getSettings();
    const promptType = getCurrentPromptType();
    const config = getPromptTypeConfig(promptType);
    
    const name = $("#summarizer-prompt-preset-select").val();
    
    if (!name) {
        showToast('error', '불러올 프리셋을 선택하세요.');
        return;
    }
    
    const presets = settings[config.presetKey] || [];
    const preset = presets.find(p => p.name === name);
    
    if (!preset) {
        showToast('error', '프리셋을 찾을 수 없습니다.');
        return;
    }
    
    $(config.textareaId).val(preset.template);
    settings[config.selectedKey] = name;
    saveSettings();
    
    showToast('success', `${config.label} 프리셋 "${name}" 불러옴`);
}

/**
 * 프롬프트 프리셋 삭제
 */
function deletePromptPreset() {
    const settings = getSettings();
    const promptType = getCurrentPromptType();
    const config = getPromptTypeConfig(promptType);
    
    const name = $("#summarizer-prompt-preset-select").val();
    
    if (!name) {
        showToast('error', '삭제할 프리셋을 선택하세요.');
        return;
    }
    
    if (!confirm(`"${name}" 프리셋을 삭제하시겠습니까?`)) {
        return;
    }
    
    if (!Array.isArray(settings[config.presetKey])) {
        settings[config.presetKey] = [];
    }
    
    settings[config.presetKey] = settings[config.presetKey].filter(p => p.name !== name);
    
    if (settings[config.selectedKey] === name) {
        settings[config.selectedKey] = "";
    }
    
    saveSettings();
    populatePromptPresets();
    
    showToast('success', `${config.label} 프리셋 "${name}" 삭제됨`);
}

// ===== API 관리 =====

/**
 * 모델 로드
 */
export async function doLoadModels() {
    try {
        showToast('info', '모델 로드 중...');
        const models = await loadModels();
        
        const $select = $("#summarizer-custom-model");
        $select.empty().append('<option value="">모델 선택...</option>');
        
        for (const model of models) {
            $select.append(`<option value="${model}">${model}</option>`);
        }
        
        showToast('success', `${models.length}개 모델 로드됨`);
    } catch (error) {
        showToast('error', `모델 로드 실패: ${error.message}`);
    }
}

/**
 * API 테스트
 */
export async function doTestApi() {
    try {
        showToast('info', 'API 연결 테스트 중...');
        await testApiConnection();
        showToast('success', 'API 연결 성공!');
    } catch (error) {
        showToast('error', `API 테스트 실패: ${error.message}`);
    }
}

/**
 * API 설정 저장
 */
export function saveApiSettings() {
    const settings = getSettings();
    
    settings.customApiUrl = $("#summarizer-custom-url").val().trim();
    settings.customApiKey = $("#summarizer-custom-key").val();
    settings.customApiModel = $("#summarizer-custom-model").val();
    settings.customApiMaxTokens = parseInt($("#summarizer-custom-max-tokens").val()) || 4000;
    settings.customApiTimeout = parseInt($("#summarizer-custom-timeout").val()) || 60;
    
    saveSettings();
    updateApiDisplay();
    showToast('success', 'API 설정이 저장되었습니다.');
}

// ===== UI 이벤트 바인딩 =====

/**
 * 모든 UI 이벤트 바인딩
 */
export function bindUIEvents() {
    const settings = getSettings();
    
    // 팝업 닫기
    $("#summarizer-close-btn").on("click", closePopup);
    $("#scenario-summarizer-popup-overlay").on("click", closePopup);
    
    // 탭 전환
    $(".summarizer-tab").on("click", function() {
        const tabId = $(this).data("tab");
        $(".summarizer-tab").removeClass("active");
        $(this).addClass("active");
        $(".summarizer-tab-content").removeClass("active");
        $(`#tab-${tabId}`).addClass("active");
        
        if (tabId === "api") updateApiDisplay();
        if (tabId === "status") updateStatusDisplay();
        if (tabId === "characters") renderCharactersList();
    });
    
    // 설정 탭
    $("#summarizer-enabled").on("change", async function() {
        settings.enabled = $(this).prop("checked");
        saveSettings();
        await updateEventListeners();
    });
    
    $("#summarizer-automatic").on("change", function() {
        settings.automaticMode = $(this).prop("checked");
        saveSettings();
    });
    
    $("#summarizer-interval").on("change", function() {
        const value = parseInt($(this).val());
        if (value >= 1 && value <= 100) {
            settings.summaryInterval = value;
            saveSettings();
            updateStatusDisplay();
        }
    });
    
    $("#summarizer-batch-size").on("change", function() {
        const value = parseInt($(this).val());
        if (value >= 1 && value <= 50) {
            settings.batchSize = value;
            saveSettings();
        }
    });
    
    $("#summarizer-preserve").on("change", function() {
        const value = parseInt($(this).val());
        if (value >= 1 && value <= 50) {
            settings.preserveRecentMessages = value;
            saveSettings();
        }
    });
    
    $("#summarizer-auto-hide").on("change", function() {
        settings.autoHideEnabled = $(this).prop("checked");
        saveSettings();
        applyMessageVisibility();
    });
    
    $("#summarizer-include-worldinfo").on("change", function() {
        settings.includeWorldInfo = $(this).prop("checked");
        saveSettings();
    });
    
    $("#summarizer-character-tracking").on("change", function() {
        settings.characterTrackingEnabled = $(this).prop("checked");
        saveSettings();
    });
    
    $("#summarizer-token-budget").on("change", function() {
        let value = parseInt($(this).val());
        if (isNaN(value) || value < 500) value = 500;
        if (value > 200000) value = 200000;
        $(this).val(value);
        settings.tokenBudget = value;
        saveSettings();
    });
    
    $("#summarizer-context-count").on("change input", function() {
        let value = parseInt($(this).val());
        if (isNaN(value) || value < 0) value = 0;
        $(this).val(value);
        $("#summarizer-context-range").val(Math.min(value, 50));
        updateContextCountDisplay(value);
        settings.summaryContextCount = value;
        saveSettings();
        log(`Summary context count set to: ${value}`);
    });
    
    $("#summarizer-context-range").on("input change", function() {
        const value = parseInt($(this).val());
        $("#summarizer-context-count").val(value);
        updateContextCountDisplay(value);
        settings.summaryContextCount = value;
        saveSettings();
        log(`Summary context count set to: ${value}`);
    });
    
    // 전체 사용 체크박스
    $("#summarizer-context-all").on("change", function() {
        const isChecked = $(this).prop("checked");
        const $countGroup = $("#summarizer-context-count-group");
        
        if (isChecked) {
            settings.summaryContextCount = -1;
            updateContextCountDisplay(-1);
            $countGroup.hide();
        } else {
            const value = parseInt($("#summarizer-context-range").val()) || 5;
            settings.summaryContextCount = value;
            updateContextCountDisplay(value);
            $countGroup.show();
        }
        saveSettings();
        log(`Summary context count set to: ${settings.summaryContextCount}`);
    });
    
    // 초기 상태 설정 - 전체 참조가 켜져있으면 슬라이더 숨김
    if (settings.summaryContextCount === -1) {
        $("#summarizer-context-count-group").hide();
    }
    
    // 요약 모드
    $("input[name='summary-mode']").on("change", function() {
        settings.summaryMode = $(this).val();
        saveSettings();
        toggleSummaryModeOptions();
    });
    
    $("#summarizer-batch-group-size").on("change", function() {
        let value = parseInt($(this).val());
        if (isNaN(value) || value < 2) value = 2;
        if (value > 50) value = 50;
        $(this).val(value);
        settings.batchGroupSize = value;
        saveSettings();
    });
    
    // 요약 언어
    $("#summarizer-language").on("change", function() {
        settings.summaryLanguage = $(this).val();
        saveSettings();
    });
    
    // 주입 위치 설정
    $("#summarizer-injection-position").on("change", function() {
        settings.injectionPosition = $(this).val();
        saveSettings();
        toggleInjectionDepthVisibility();
    });
    
    $("#summarizer-injection-depth").on("change", function() {
        let value = parseInt($(this).val());
        if (isNaN(value) || value < 0) value = 0;
        if (value > 100) value = 100;
        $(this).val(value);
        settings.injectionDepth = value;
        saveSettings();
    });
    
    $("#summarizer-injection-template").on("change", function() {
        const template = $(this).val();
        if (!template.includes("{{summary}}")) {
            showToast('warning', '주입 템플릿에 {{summary}} 매크로가 필요합니다');
            return;
        }
        settings.injectionTemplate = template;
        saveSettings();
    });
    
    // UI 테마 변경
    $("#summarizer-ui-theme").on("change", function() {
        const theme = $(this).val();
        settings.uiTheme = theme;
        applyUITheme(theme);
        saveSettings();
    });

    $("#summarizer-max-summary-length").on("change", function() {
        let value = parseInt($(this).val());
        if (isNaN(value) || value < 100) value = 100;
        if (value > 2000) value = 2000;
        $(this).val(value);
        settings.maxSummaryLength = value;
        saveSettings();
    });
    
    // 카테고리 추가 버튼
    $("#summarizer-add-category").on("click", showAddCategoryForm);
    
    // 카테고리 전체 초기화 버튼
    $("#summarizer-reset-all-categories").on("click", resetAllCategoriesToDefault);
    
    // API 설정
    $("input[name='api-source']").on("change", function() {
        settings.apiSource = $(this).val();
        saveSettings();
        toggleCustomApiSection();
        updateApiDisplay();
    });
    
    $("#summarizer-use-raw").on("change", function() {
        settings.useRawPrompt = $(this).prop("checked");
        saveSettings();
    });
    
    // SillyTavern Connection Profile
    $("#summarizer-st-profile").on("change", function() {
        settings.stConnectionProfile = $(this).val();
        saveSettings();
        updateApiDisplay();
    });
    
    // 커스텀 API 프리셋
    $("#summarizer-preset-select").on("change", loadSelectedPreset);
    $("#summarizer-save-preset").on("click", saveApiPreset);
    $("#summarizer-delete-preset").on("click", deleteApiPreset);
    
    $("#summarizer-load-models").on("click", doLoadModels);
    $("#summarizer-save-api").on("click", saveApiSettings);
    $("#summarizer-test-api").on("click", doTestApi);
    
    // 상태 탭
    $("#summarizer-run-now").on("click", runManualSummary);
    $("#summarizer-stop").on("click", stopSummary);
    $("#summarizer-view-summary").on("click", viewSummaries);
    $("#summarizer-preview-close").on("click", closePreview);
    $("#summarizer-restore-visibility").on("click", doRestoreVisibility);
    $("#summarizer-reset-summaries").on("click", doResetSummariesOnly);
    $("#summarizer-reset").on("click", doReset);
    
    // 에러 로그
    $("#summarizer-view-errors").on("click", showErrorLogs);
    $("#summarizer-clear-errors").on("click", doClearErrorLogs);
    
    // 범위 설정
    $("#summarizer-custom-range").on("change", function() {
        if ($(this).prop("checked")) {
            $("#summarizer-range-inputs").show();
        } else {
            $("#summarizer-range-inputs").hide();
        }
    });
    
    // 검색
    $("#summarizer-search-btn").on("click", doSearch);
    $("#summarizer-search-input").on("keypress", function(e) {
        if (e.key === "Enter") doSearch();
    });
    
    // 내보내기/가져오기
    $("#summarizer-export").on("click", doExport);
    $("#summarizer-import").on("click", doImport);
    
    // 프롬프트 탭 - 개별 요약
    $("#summarizer-save-prompt").on("click", savePromptTemplate);
    $("#summarizer-reset-prompt").on("click", resetPromptTemplate);
    
    // 프롬프트 탭 - 그룹 요약
    $("#summarizer-save-batch-prompt").on("click", saveBatchPromptTemplate);
    $("#summarizer-reset-batch-prompt").on("click", resetBatchPromptTemplate);
    
    // 프롬프트 탭 - 등장인물 추출
    $("#summarizer-save-character-prompt").on("click", saveCharacterPromptTemplate);
    $("#summarizer-reset-character-prompt").on("click", resetCharacterPromptTemplate);
    
    // 프롬프트 서브탭 전환
    $(".summarizer-prompt-subtab").on("click", function() {
        const promptType = $(this).data("prompt-type");
        switchPromptSubtab(promptType);
    });
    
    // 프롬프트 프리셋
    $("#summarizer-save-prompt-preset").on("click", savePromptPreset);
    $("#summarizer-load-prompt-preset").on("click", loadPromptPreset);
    $("#summarizer-delete-prompt-preset").on("click", deletePromptPreset);
    
    // 클립보드 복사
    $("#summarizer-copy-to-clipboard").on("click", async function() {
        const preview = await getInjectionPreview();
        try {
            // 기본 Clipboard API 시도
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(preview);
                showToast('success', '클립보드에 복사되었습니다!');
            } else {
                // 폴백: execCommand 사용
                if (copyTextFallback(preview)) {
                    showToast('success', '클립보드에 복사되었습니다!');
                } else {
                    showToast('error', '복사 실패');
                }
            }
        } catch (error) {
            // 폴백: execCommand 사용
            if (copyTextFallback(preview)) {
                showToast('success', '클립보드에 복사되었습니다!');
            } else {
                showToast('error', '복사 실패');
            }
        }
    });
    
    // 등장인물 탭
    $("#summarizer-add-character").on("click", showCharacterForm);
    $("#summarizer-cancel-character").on("click", hideCharacterForm);
    $("#summarizer-save-character").on("click", saveCharacterFromForm);
    // AI로 추출 버튼 숨김 처리 (최근 30개 메시지만 읽어 부정확함. 요약 중 자동 추출만 유지)
    $("#summarizer-extract-characters").hide();
    $("#summarizer-export-characters").on("click", exportCharactersToClipboard);
    $("#summarizer-export-characters-file").on("click", exportCharactersToFile);
    $("#summarizer-import-characters").on("click", () => $("#summarizer-characters-file-input").click());
    $("#summarizer-characters-file-input").on("change", importCharactersFromFile);
    $("#summarizer-clear-characters").on("click", clearAllCharacters);
}

// ===== 등장인물 관리 =====

let editingCharacterName = null; // 수정 중인 캐릭터 이름

/**
 * 등장인물 목록 렌더링
 */
export function renderCharactersList() {
    const characters = getCharacters();
    const names = Object.keys(characters);
    const $list = $("#summarizer-characters-list");
    
    if (names.length === 0) {
        $list.html('<p class="summarizer-placeholder">등록된 등장인물이 없습니다.</p>');
        return;
    }
    
    let html = '';
    for (const name of names.sort()) {
        const char = characters[name];
        
        // 메타 정보 태그 생성 (역할, 나이, 직업)
        const metaItems = [];
        if (char.role) metaItems.push(char.role);
        if (char.age) metaItems.push(char.age);
        if (char.occupation) metaItems.push(char.occupation);
        
        // 첫 등장 표시
        const firstAppearanceText = char.firstAppearance !== null ? `첫등장 #${char.firstAppearance + 1}` : '';
        
        html += `
        <div class="summarizer-character-card" data-name="${escapeHtml(name)}">
            <div class="summarizer-character-header">
                <div class="summarizer-character-name-row">
                    <span class="summarizer-character-name">${escapeHtml(name)}</span>
                    ${firstAppearanceText ? `<span class="summarizer-character-first-appearance">${firstAppearanceText}</span>` : ''}
                </div>
                <div class="summarizer-character-actions">
                    <button class="summarizer-btn summarizer-btn-tiny summarizer-edit-character" data-name="${escapeHtml(name)}" title="수정">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="summarizer-btn summarizer-btn-tiny summarizer-delete-character" data-name="${escapeHtml(name)}" title="삭제">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            ${metaItems.length > 0 ? `
                <div class="summarizer-character-meta">
                    ${metaItems.map(item => `<span class="summarizer-character-meta-item">${escapeHtml(item)}</span>`).join('')}
                </div>
            ` : ''}
            ${char.description ? `<div class="summarizer-character-description">${escapeHtml(char.description)}</div>` : ''}
            ${char.traits && char.traits.length > 0 ? `
                <div class="summarizer-character-traits">
                    ${char.traits.map(t => `<span class="summarizer-character-trait">${escapeHtml(t)}</span>`).join('')}
                </div>
            ` : ''}
            ${char.relationshipWithUser ? `
                <div class="summarizer-character-footer">
                    <div class="summarizer-character-footer-item">
                        <span class="summarizer-character-footer-label">{{user}}와의 관계</span>
                        <span class="summarizer-character-footer-value">${escapeHtml(char.relationshipWithUser)}</span>
                    </div>
                </div>
            ` : ''}
        </div>`;
    }
    
    $list.html(html);
    
    // 이벤트 바인딩
    $(".summarizer-edit-character").off("click").on("click", function() {
        const name = $(this).data("name");
        editCharacter(name);
    });
    
    $(".summarizer-delete-character").off("click").on("click", async function() {
        const name = $(this).data("name");
        if (!confirm(`'${name}' 캐릭터를 삭제하시겠습니까?`)) return;
        
        deleteCharacter(name);
        await saveSummaryData();
        renderCharactersList();
        showToast('success', `'${name}' 삭제됨`);
    });
}

/**
 * 등장인물 추가 폼 표시
 */
function showCharacterForm() {
    editingCharacterName = null;
    $("#character-form-title").text("등장인물 추가");
    $("#character-name").val("").prop("disabled", false);
    $("#character-role").val("");
    $("#character-age").val("");
    $("#character-occupation").val("");
    $("#character-description").val("");
    $("#character-traits").val("");
    $("#character-relationship").val("");
    $("#summarizer-character-form").show();
}

/**
 * 등장인물 폼 숨기기
 */
function hideCharacterForm() {
    editingCharacterName = null;
    $("#summarizer-character-form").hide();
}

/**
 * 등장인물 수정
 */
function editCharacter(name) {
    const char = getCharacter(name);
    if (!char) return;
    
    editingCharacterName = name;
    $("#character-form-title").text("등장인물 수정");
    $("#character-name").val(name).prop("disabled", true);
    $("#character-role").val(char.role || "");
    $("#character-age").val(char.age || "");
    $("#character-occupation").val(char.occupation || "");
    $("#character-description").val(char.description || "");
    $("#character-traits").val((char.traits || []).join(", "));
    $("#character-relationship").val(char.relationshipWithUser || "");
    $("#summarizer-character-form").show();
}

/**
 * 폼에서 등장인물 저장
 */
async function saveCharacterFromForm() {
    const name = editingCharacterName || $("#character-name").val().trim();
    
    if (!name) {
        showToast('error', '이름을 입력하세요');
        return;
    }
    
    const role = $("#character-role").val().trim();
    const age = $("#character-age").val().trim();
    const occupation = $("#character-occupation").val().trim();
    const description = $("#character-description").val().trim();
    const traitsStr = $("#character-traits").val().trim();
    const traits = traitsStr ? traitsStr.split(",").map(t => t.trim()).filter(t => t) : [];
    const relationshipWithUser = $("#character-relationship").val().trim();
    
    setCharacter(name, {
        role,
        age,
        occupation,
        description,
        traits,
        relationshipWithUser
    });
    
    await saveSummaryData();
    hideCharacterForm();
    renderCharactersList();
    showToast('success', `'${name}' 저장됨`);
}

/**
 * 등장인물 정보 클립보드에 복사
 */
async function exportCharactersToClipboard() {
    const text = formatCharactersText();
    
    try {
        // 기본 Clipboard API 시도
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            showToast('success', '등장인물 정보가 복사되었습니다!');
        } else {
            // 폴백: execCommand 사용
            if (copyTextFallback(text)) {
                showToast('success', '등장인물 정보가 복사되었습니다!');
            } else {
                showToast('error', '복사 실패: 브라우저가 클립보드 접근을 지원하지 않습니다');
            }
        }
    } catch (error) {
        // 폴백: execCommand 사용
        if (copyTextFallback(text)) {
            showToast('success', '등장인물 정보가 복사되었습니다!');
        } else {
            showToast('error', `복사 실패: ${error.message}`, { error, context: 'exportCharactersToClipboard' });
        }
    }
}

/**
 * 등장인물 정보 JSON 파일로 내보내기
 */
function exportCharactersToFile() {
    const characters = getCharacters();
    const count = Object.keys(characters).length;
    
    if (count === 0) {
        showToast('error', '내보낼 등장인물이 없습니다');
        return;
    }
    
    const data = {
        version: 1,
        exportDate: new Date().toISOString(),
        characters: characters
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `characters_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('success', `${count}명의 등장인물 내보내기 완료`);
}

/**
 * 등장인물 정보 JSON 파일에서 가져오기
 */
async function importCharactersFromFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        if (!data.characters || typeof data.characters !== 'object') {
            showToast('error', '유효하지 않은 파일 형식');
            return;
        }
        
        const importCount = Object.keys(data.characters).length;
        
        if (!confirm(`${importCount}명의 등장인물을 가져오시겠습니까?\n(기존 동일 이름 캐릭터는 덮어쓰기됩니다)`)) {
            event.target.value = '';
            return;
        }
        
        // 각 캐릭터 병합
        for (const [name, info] of Object.entries(data.characters)) {
            setCharacter(name, info);
        }
        
        await saveSummaryData();
        renderCharactersList();
        showToast('success', `${importCount}명의 등장인물 가져오기 완료`);
    } catch (e) {
        showToast('error', `가져오기 실패: ${e.message}`);
    }
    
    event.target.value = '';
}

/**
 * 모든 등장인물 초기화
 */
async function clearAllCharacters() {
    const characters = getCharacters();
    const count = Object.keys(characters).length;
    
    if (count === 0) {
        showToast('info', '삭제할 등장인물이 없습니다');
        return;
    }
    
    if (!confirm(`정말 ${count}명의 등장인물을 모두 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
        return;
    }
    
    const summaryData = getSummaryData();
    if (summaryData) {
        summaryData.characters = {};
        summaryData.lastUpdate = new Date().toLocaleString("ko-KR");
    }
    
    await saveSummaryData();
    renderCharactersList();
    showToast('success', '등장인물 초기화 완료');
}

// ===== 에러 로그 관리 =====

/**
 * 에러 로그 표시
 */
function showErrorLogs() {
    const errors = getErrorLogs(20);
    const $container = $("#summarizer-error-log");
    
    if (errors.length === 0) {
        $container.html('<div class="summarizer-error-empty"><i class="fa-solid fa-check-circle"></i> 에러 로그가 없습니다</div>');
    } else {
        let html = '';
        for (const err of errors) {
            const time = new Date(err.timestamp).toLocaleString('ko-KR');
            const stack = err.stack 
                ? `<div class="summarizer-error-details"><strong>Stack Trace:</strong>\n${escapeHtml(err.stack)}</div>` 
                : '';
            const details = Object.keys(err.details).length > 0 
                ? `<div class="summarizer-error-details"><strong>Details:</strong>\n${escapeHtml(JSON.stringify(err.details, null, 2))}</div>` 
                : '';
            
            html += `
                <div class="summarizer-error-item">
                    <div class="summarizer-error-time">${time}</div>
                    <div class="summarizer-error-context">${escapeHtml(err.context)}</div>
                    <div class="summarizer-error-message">${escapeHtml(err.message)}</div>
                    ${stack}
                    ${details}
                </div>
            `;
        }
        $container.html(html);
    }
    
    $container.toggle();
}

/**
 * 에러 로그 초기화
 */
function doClearErrorLogs() {
    clearErrorLogs();
    $("#summarizer-error-log").html('<div class="summarizer-error-empty"><i class="fa-solid fa-check-circle"></i> 에러 로그가 없습니다</div>');
    showToast('success', '에러 로그가 초기화되었습니다');
}
