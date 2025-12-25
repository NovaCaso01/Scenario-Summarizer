/**
 * 시나리오 자동요약 - 상태 관리
 */

import { extension_settings } from "../../../../extensions.js";
import { extensionName } from './constants.js';

// ===== 공유 설정 접근 =====

/**
 * 설정 가져오기 (전역 공유)
 * @returns {Object}
 */
export function getSettings() {
    return extension_settings[extensionName] || {};
}

// ===== 에러 로그 시스템 =====

// 최근 에러 기록 (최대 50개)
const errorLogs = [];
const MAX_ERROR_LOGS = 50;

/**
 * 에러 로그 추가
 * @param {string} context - 에러 발생 위치
 * @param {Error|string} error - 에러 객체 또는 메시지
 * @param {Object} details - 추가 정보 (optional)
 */
export function logError(context, error, details = {}) {
    const errorEntry = {
        timestamp: new Date().toISOString(),
        context,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        details
    };
    
    errorLogs.unshift(errorEntry);
    if (errorLogs.length > MAX_ERROR_LOGS) {
        errorLogs.pop();
    }
    
    console.error(`[${extensionName}] ${context}:`, error, details);
}

/**
 * 에러 로그 조회
 * @param {number} limit - 최대 개수 (기본 10)
 * @returns {Array}
 */
export function getErrorLogs(limit = 10) {
    return errorLogs.slice(0, limit);
}

/**
 * 에러 로그 초기화
 */
export function clearErrorLogs() {
    errorLogs.length = 0;
}

/**
 * 마지막 에러 가져오기
 * @returns {Object|null}
 */
export function getLastError() {
    return errorLogs[0] || null;
}

// ===== 작업 상태 =====

// 작업 상태
export const operationState = {
    isSummarizing: false,          // 요약 진행 중
    shouldStop: false,             // 중단 요청됨
    generationInProgress: false,   // AI 생성 진행 중
    chatLoadingCooldown: false     // 채팅 로딩 중
};

// 채팅 로딩 쿨다운 타이머
let chatLoadingTimeout = null;

/**
 * 요약 시작
 */
export function startSummarizing() {
    operationState.isSummarizing = true;
    operationState.shouldStop = false;
}

/**
 * 요약 종료
 */
export function stopSummarizing() {
    operationState.isSummarizing = false;
    operationState.shouldStop = false;
}

/**
 * 중단 요청
 */
export function requestStop() {
    operationState.shouldStop = true;
}

/**
 * 중단 여부 확인
 */
export function shouldStop() {
    return operationState.shouldStop;
}

/**
 * 요약 중인지 확인
 */
export function isSummarizing() {
    return operationState.isSummarizing;
}

/**
 * AI 생성 락 설정
 */
export function setGenerationLock() {
    operationState.generationInProgress = true;
}

/**
 * AI 생성 락 해제
 */
export function clearGenerationLock() {
    operationState.generationInProgress = false;
}

/**
 * AI 생성 중인지 확인
 */
export function isGenerationInProgress() {
    return operationState.generationInProgress;
}

/**
 * 채팅 로딩 쿨다운 설정
 * @param {number} ms - 쿨다운 시간 (밀리초)
 */
export function setChatLoadingCooldown(ms = 2000) {
    operationState.chatLoadingCooldown = true;
    
    if (chatLoadingTimeout) {
        clearTimeout(chatLoadingTimeout);
    }
    
    chatLoadingTimeout = setTimeout(() => {
        operationState.chatLoadingCooldown = false;
        chatLoadingTimeout = null;
        log('Chat loading cooldown ended');
    }, ms);
    
    log('Chat loading cooldown started');
}

/**
 * 채팅 로딩 쿨다운 중인지 확인
 */
export function isChatLoadingCooldown() {
    return operationState.chatLoadingCooldown;
}

/**
 * 모든 상태 초기화
 */
export function resetAllStates() {
    operationState.isSummarizing = false;
    operationState.shouldStop = false;
    operationState.generationInProgress = false;
    operationState.chatLoadingCooldown = false;
    
    if (chatLoadingTimeout) {
        clearTimeout(chatLoadingTimeout);
        chatLoadingTimeout = null;
    }
}

/**
 * 디버그 로그
 */
export function log(message) {
    console.log(`[${extensionName}] ${message}`);
}

/**
 * 조건부 디버그 로그 (settings 필요)
 */
export function debugLog(settings, message) {
    if (settings?.debugMode) {
        console.log(`[${extensionName}][DEBUG] ${message}`);
    }
}
