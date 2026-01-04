/**
 * 시나리오 자동요약 - 데이터 저장/로드
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { saveChatConditional } from "../../../../../script.js";
import { extensionName, METADATA_KEY, DATA_VERSION } from './constants.js';
import { log, getSettings } from './state.js';

/**
 * 요약 데이터 가져오기 (없으면 초기화)
 * @returns {Object|null}
 */
export function getSummaryData() {
    const context = getContext();
    if (!context) {
        log('getContext() 반환값 없음');
        return null;
    }
    
    if (!context.chatMetadata) {
        context.chatMetadata = {};
    }
    
    if (!context.chatMetadata[METADATA_KEY]) {
        context.chatMetadata[METADATA_KEY] = createEmptyData();
    }
    
    // 데이터 마이그레이션 체크
    const data = context.chatMetadata[METADATA_KEY];
    if (needsMigration(data)) {
        context.chatMetadata[METADATA_KEY] = migrateData(data);
        log('데이터 마이그레이션 완료: v' + DATA_VERSION);
    }
    
    return context.chatMetadata[METADATA_KEY];
}

/**
 * 빈 데이터 구조 생성
 */
export function createEmptyData() {
    return {
        version: DATA_VERSION,
        summaries: {},              // 메시지 인덱스 -> 요약 객체
        legacySummaries: [],        // 인계된 요약 배열 (새 채팅방으로 이전 시 사용)
        characters: {},             // 캐릭터 이름 -> 캐릭터 정보 객체
        events: [],                 // 주요 이벤트 배열
        items: [],                  // 주요 아이템 배열
        lastSummarizedIndex: -1,
        lastUpdate: null
    };
}

/**
 * 마이그레이션 필요 여부 확인
 */
function needsMigration(data) {
    // 버전이 없거나 현재 버전보다 낮으면 마이그레이션 필요
    if (!data.version || data.version < DATA_VERSION) {
        return true;
    }
    // 구버전 entries 배열이 있으면 마이그레이션 필요
    if (data.entries && Array.isArray(data.entries)) {
        return true;
    }
    return false;
}

/**
 * 구버전 데이터를 새 버전으로 마이그레이션
 * @param {Object} oldData - 기존 데이터
 * @returns {Object} - 새 데이터 구조
 */
function migrateData(oldData) {
    const newData = createEmptyData();
    
    // v2 -> v3: legacySummaries 배열 초기화
    if (oldData.legacySummaries && Array.isArray(oldData.legacySummaries)) {
        newData.legacySummaries = oldData.legacySummaries;
    }
    
    // v3 -> v4: events, items 배열 초기화
    if (oldData.events && Array.isArray(oldData.events)) {
        newData.events = oldData.events;
    }
    if (oldData.items && Array.isArray(oldData.items)) {
        newData.items = oldData.items;
    }
    
    // characters 마이그레이션
    if (oldData.characters && typeof oldData.characters === 'object') {
        newData.characters = oldData.characters;
    }
    
    // 구버전 entries 배열이 있으면 변환
    if (oldData.entries && Array.isArray(oldData.entries)) {
        for (const entry of oldData.entries) {
            // 범위 내 각 메시지에 요약 할당
            // 파싱 시도: #번호 형식으로 분리
            const parsed = parseEntrySummaries(entry.content, entry.startIndex, entry.endIndex);
            
            for (const [index, summary] of Object.entries(parsed)) {
                newData.summaries[index] = {
                    messageIndex: parseInt(index),
                    content: summary,
                    timestamp: entry.timestamp || new Date().toISOString(),
                    migratedFrom: `${entry.startIndex}-${entry.endIndex}`
                };
            }
        }
        
        newData.lastSummarizedIndex = oldData.lastSummarizedIndex ?? -1;
        newData.lastUpdate = oldData.lastUpdate;
    } else {
        // 이미 summaries 형태면 버전만 업데이트 (형식 검증 포함)
        if (oldData.summaries) {
            // 각 요약이 올바른 객체 형식인지 확인하고 수정
            for (const [index, summary] of Object.entries(oldData.summaries)) {
                // 문자열로 저장된 경우 객체로 변환
                if (typeof summary === 'string') {
                    newData.summaries[index] = {
                        messageIndex: parseInt(index),
                        content: summary,
                        timestamp: new Date().toISOString(),
                        migrated: true
                    };
                } 
                // 이미 객체지만 content가 없는 경우
                else if (typeof summary === 'object' && summary !== null) {
                    if (!summary.content) {
                        // content가 없으면 빈 문자열로 설정하고 나머지 필드 유지
                        newData.summaries[index] = {
                            ...summary,  // 기존 필드 유지
                            messageIndex: parseInt(index),
                            content: '[데이터 오류: content 누락]',
                            timestamp: summary.timestamp || new Date().toISOString(),
                            migrated: true
                        };
                    } else {
                        // 정상 객체는 그대로 복사
                        newData.summaries[index] = summary;
                    }
                }
                // null이나 undefined는 건너뛰기
            }
        }
        newData.lastSummarizedIndex = oldData.lastSummarizedIndex ?? -1;
        newData.lastUpdate = oldData.lastUpdate;
    }
    
    return newData;
}

/**
 * 범위 요약 텍스트를 개별 메시지별로 파싱
 * @param {string} content - 전체 요약 텍스트
 * @param {number} startIndex - 시작 인덱스
 * @param {number} endIndex - 끝 인덱스
 * @returns {Object} - { 인덱스: 요약내용 }
 */
function parseEntrySummaries(content, startIndex, endIndex) {
    const result = {};
    
    // #숫자 패턴으로 분리 시도
    const pattern = /#(\d+)\s*\n([\s\S]*?)(?=#\d+\s*\n|$)/g;
    let match;
    
    while ((match = pattern.exec(content)) !== null) {
        const msgNum = parseInt(match[1]);
        const summary = match[2].trim();
        const index = msgNum - 1; // 메시지 번호는 1부터, 인덱스는 0부터
        
        if (index >= startIndex && index <= endIndex) {
            result[index] = `#${msgNum}\n${summary}`;
        }
    }
    
    // 파싱 실패 시 전체 내용을 첫 번째 메시지에 할당
    if (Object.keys(result).length === 0) {
        result[startIndex] = content;
    }
    
    return result;
}

/**
 * 요약 데이터 저장
 * @returns {Promise<boolean>}
 */
export async function saveSummaryData() {
    try {
        await saveChatConditional();
        log('요약 데이터 저장됨');
        
        // 요약 데이터 변경 이벤트 발생 (UI 업데이트용)
        window.dispatchEvent(new CustomEvent('summaryDataChanged'));
        
        return true;
    } catch (error) {
        console.error(`[${extensionName}] Failed to save:`, error);
        return false;
    }
}

/**
 * 현재 채팅 ID 가져오기
 * @returns {string|null}
 */
export function getCurrentChatId() {
    const context = getContext();
    return context?.chatId || null;
}

/**
 * 캐릭터 이름 가져오기
 * @returns {string}
 */
export function getCharacterName() {
    const context = getContext();
    return context?.name2 || "캐릭터";
}

/**
 * 유저 이름 가져오기
 * @returns {string}
 */
export function getUserName() {
    const context = getContext();
    return context?.name1 || "유저";
}

/**
 * 현재 채팅 길이 기준으로 유효한 요약만 반환
 * 마지막 메시지를 초과하는 그룹 요약은 제외 (분기 대응)
 * @returns {Object} - { 인덱스: 요약객체 }
 */
export function getRelevantSummaries() {
    const context = getContext();
    const currentChatLength = context?.chat?.length || 0;
    const lastMessageIndex = currentChatLength - 1; // 마지막 메시지 인덱스
    const data = getSummaryData();
    
    if (!data || !data.summaries) {
        return {};
    }
    
    const relevant = {};
    for (const [index, summary] of Object.entries(data.summaries)) {
        // 손상된 데이터 방어
        if (!summary || typeof summary !== 'object') continue;
        
        const idx = parseInt(index);
        
        // 그룹 요약인지 확인 (#시작-끝 형식)
        const content = summary?.content || '';
        const rangeMatch = content.match(/^#(\d+)-(\d+)/);
        
        if (rangeMatch) {
            // 그룹 요약: 끝 인덱스가 마지막 메시지 이하여야 함
            const groupEnd = parseInt(rangeMatch[2]);
            if (groupEnd <= lastMessageIndex) {
                relevant[index] = summary;
            }
        } else {
            // 개별 요약: 인덱스가 마지막 메시지 이하여야 함
            if (idx <= lastMessageIndex) {
                relevant[index] = summary;
            }
        }
    }
    
    return relevant;
}

/**
 * 특정 메시지의 요약 가져오기
 * @param {number} messageIndex 
 * @returns {Object|null}
 */
export function getSummaryForMessage(messageIndex) {
    const data = getSummaryData();
    return data?.summaries?.[messageIndex] || null;
}

/**
 * 현재 채팅 범위를 벗어난 요약 정리
 * 메시지 삭제 시 요약 인덱스가 맞지 않는 문제 해결
 * 그룹 요약의 경우 끝 인덱스가 현재 채팅 범위를 벗어나면 삭제
 * @returns {number} - 정리된 요약 수
 */
export function cleanupOrphanedSummaries() {
    const context = getContext();
    const data = getSummaryData();
    
    if (!context?.chat || !data?.summaries) return 0;
    
    const totalMessages = context.chat.length;
    const lastMessageIndex = totalMessages - 1; // 마지막 메시지 인덱스
    let cleanedCount = 0;
    const indicesToDelete = new Set();
    
    // 1차: 삭제할 요약 식별
    for (const indexStr of Object.keys(data.summaries)) {
        const index = parseInt(indexStr);
        const summary = data.summaries[indexStr];
        const content = summary?.content || '';
        
        // 그룹 요약인지 확인 (#시작-끝 형식)
        const rangeMatch = content.match(/^#(\d+)-(\d+)/);
        
        if (rangeMatch) {
            // 그룹 요약: 끝 인덱스가 마지막 메시지를 초과하면 삭제
            const groupStart = parseInt(rangeMatch[1]);
            const groupEnd = parseInt(rangeMatch[2]);
            if (groupEnd > lastMessageIndex) {
                indicesToDelete.add(indexStr);
                // 그룹에 포함된 모든 인덱스도 삭제 대상에 추가
                for (let i = groupStart; i <= groupEnd; i++) {
                    if (data.summaries[i]) {
                        indicesToDelete.add(String(i));
                    }
                }
            }
        } else if (content.includes('그룹 요약에 포함')) {
            // "→ #X-Y 그룹 요약에 포함" 형태의 참조 요약
            // 참조하는 그룹이 삭제되면 이것도 삭제됨 (아래에서 처리)
            const refMatch = content.match(/#(\d+)-(\d+)/);
            if (refMatch) {
                const refEnd = parseInt(refMatch[2]);
                if (refEnd > lastMessageIndex) {
                    indicesToDelete.add(indexStr);
                }
            }
        } else {
            // 개별 요약: 인덱스가 마지막 메시지를 초과하면 삭제
            if (index > lastMessageIndex) {
                indicesToDelete.add(indexStr);
            }
        }
    }
    
    // 2차: 삭제 실행
    for (const indexStr of indicesToDelete) {
        delete data.summaries[indexStr];
        cleanedCount++;
    }
    
    if (cleanedCount > 0) {
        log(`Cleaned up ${cleanedCount} orphaned summaries (message count: ${totalMessages})`);
    }
    
    return cleanedCount;
}

/**
 * 특정 메시지의 요약 저장
 * @param {number} messageIndex 
 * @param {string} content 
 * @returns {Object} - 저장된 요약 객체
 */
export function setSummaryForMessage(messageIndex, content) {
    const data = getSummaryData();
    if (!data) return null;
    
    const summary = {
        messageIndex: messageIndex,
        content: content,
        timestamp: new Date().toISOString()
    };
    
    data.summaries[messageIndex] = summary;
    
    // lastSummarizedIndex 업데이트
    if (messageIndex > data.lastSummarizedIndex) {
        data.lastSummarizedIndex = messageIndex;
    }
    
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return summary;
}

/**
 * 특정 메시지의 요약 삭제
 * @param {number} messageIndex 
 */
export function deleteSummaryForMessage(messageIndex) {
    const data = getSummaryData();
    if (!data || !data.summaries) return;
    
    const summary = data.summaries[messageIndex];
    const content = summary?.content ?? summary ?? '';
    
    // 그룹 요약인 경우 (#X-Y 패턴), 연결된 모든 항목도 삭제
    const groupMatch = String(content).match(/^#(\d+)-(\d+)/);
    if (groupMatch) {
        const startIdx = parseInt(groupMatch[1]);
        const endIdx = parseInt(groupMatch[2]);
        
        // 그룹 범위 내 모든 요약 삭제
        for (let i = startIdx; i <= endIdx; i++) {
            delete data.summaries[i];
        }
    } 
    // "그룹 요약에 포함" 표시인 경우, 해당 그룹 전체 삭제
    else if (String(content).includes('그룹 요약에 포함')) {
        const refMatch = String(content).match(/\[→ #(\d+)-(\d+) 그룹 요약에 포함\]/);
        if (refMatch) {
            const startIdx = parseInt(refMatch[1]);
            const endIdx = parseInt(refMatch[2]);
            
            // 그룹 범위 내 모든 요약 삭제
            for (let i = startIdx; i <= endIdx; i++) {
                delete data.summaries[i];
            }
        } else {
            // 패턴 매칭 실패 시 현재 항목만 삭제
            delete data.summaries[messageIndex];
        }
    }
    else {
        // 개별 요약: 해당 인덱스만 삭제
        delete data.summaries[messageIndex];
    }
    
    // lastSummarizedIndex 재계산
    const indices = Object.keys(data.summaries).map(Number);
    data.lastSummarizedIndex = indices.length > 0 ? Math.max(...indices) : -1;
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * 메시지 삭제 시 요약 인덱스 및 범위 재매핑
 * - 개별 요약: 삭제된 인덱스의 요약 삭제, 이후 인덱스 -1
 * - 묶음 요약: 범위 번호 업데이트 (범위 내 삭제 시 축소, 범위 앞 삭제 시 -1)
 * - 스와이프는 별도 처리 (무효화)
 * @param {number} deletedIndex - 삭제된 메시지의 인덱스 (0-indexed)
 */
export function remapSummariesAfterDeletion(deletedIndex) {
    const data = getSummaryData();
    if (!data || !data.summaries) return;
    
    const newSummaries = {};
    
    for (const [indexStr, summary] of Object.entries(data.summaries)) {
        const index = parseInt(indexStr);
        
        // 묶음 요약인지 확인 (#시작-끝 패턴)
        const rangeMatch = summary.content?.match(/^#(\d+)-(\d+)/);
        
        if (rangeMatch) {
            // 묶음 요약 처리 (content의 번호도 0-indexed)
            let rangeStart = parseInt(rangeMatch[1]);
            let rangeEnd = parseInt(rangeMatch[2]);
            
            if (deletedIndex >= rangeStart && deletedIndex <= rangeEnd) {
                // 범위 내 삭제 → 범위 끝 -1
                rangeEnd = rangeEnd - 1;
                
                // content의 범위 번호 업데이트
                summary.content = summary.content.replace(
                    /^#\d+-\d+/,
                    `#${rangeStart}-${rangeEnd}`
                );
                
            } else if (deletedIndex < rangeStart) {
                // 범위 앞 삭제 → 범위 전체 -1
                rangeStart = rangeStart - 1;
                rangeEnd = rangeEnd - 1;
                
                // content의 범위 번호 업데이트
                summary.content = summary.content.replace(
                    /^#\d+-\d+/,
                    `#${rangeStart}-${rangeEnd}`
                );
            }
            // 범위 뒤 삭제 → 범위 변경 없음
            
            // 저장 인덱스 재매핑
            if (index > deletedIndex) {
                newSummaries[index - 1] = summary;
            } else {
                newSummaries[index] = summary;
            }
            
        } else {
            // 개별 요약 처리
            if (index === deletedIndex) {
                // 삭제된 메시지의 요약 → 삭제
                continue;
            } else if (index > deletedIndex) {
                // 삭제 위치 이후 → 인덱스 -1
                summary.messageIndex = index - 1;
                newSummaries[index - 1] = summary;
            } else {
                // 삭제 위치 이전 → 그대로
                newSummaries[index] = summary;
            }
        }
    }
    
    data.summaries = newSummaries;
    
    // lastSummarizedIndex 재계산
    const indices = Object.keys(data.summaries).map(Number);
    data.lastSummarizedIndex = indices.length > 0 ? Math.max(...indices) : -1;
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    log(`Summaries remapped after deletion of message #${deletedIndex}`);
}

/**
 * 스와이프 시 해당 메시지 요약 무효화
 * - 개별 요약: 해당 인덱스의 요약 삭제
 * - 묶음 요약: 스와이프된 메시지가 범위 내에 있으면 무효화
 * @param {number} messageIndex - 스와이프된 메시지 인덱스 (0-indexed)
 */
export function invalidateSummaryOnSwipe(messageIndex) {
    const data = getSummaryData();
    if (!data || !data.summaries) return;
    
    // 모든 요약을 순회하며 해당 메시지가 포함된 요약 찾기
    for (const [indexStr, summary] of Object.entries(data.summaries)) {
        const index = parseInt(indexStr);
        const rangeMatch = summary.content?.match(/^#(\d+)-(\d+)/);
        
        if (rangeMatch) {
            // 묶음 요약: 스와이프된 메시지가 범위 내에 있는지 확인 (0-indexed)
            const rangeStart = parseInt(rangeMatch[1]);
            const rangeEnd = parseInt(rangeMatch[2]);
            
            if (messageIndex >= rangeStart && messageIndex <= rangeEnd) {
                summary.invalidated = true;
                summary.invalidReason = `메시지 #${messageIndex} 스와이프됨`;
                log(`Batch summary #${rangeStart}-${rangeEnd} invalidated due to swipe of message #${messageIndex}`);
            }
        } else {
            // 개별 요약: 정확히 해당 인덱스면 삭제
            if (index === messageIndex) {
                delete data.summaries[indexStr];
                log(`Summary for message #${messageIndex} deleted due to swipe`);
            }
        }
    }
    
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * 모든 요약 삭제
 */
export function clearAllSummaries() {
    const context = getContext();
    if (!context?.chatMetadata) return;
    
    const data = getSummaryData();
    if (!data) {
        context.chatMetadata[METADATA_KEY] = createEmptyData();
        return;
    }
    
    // 등장인물 정보와 인계된 요약은 유지하고 현재 요약만 초기화
    const preservedCharacters = data.characters || {};
    const preservedLegacySummaries = data.legacySummaries || [];
    context.chatMetadata[METADATA_KEY] = {
        ...createEmptyData(),
        characters: preservedCharacters,
        legacySummaries: preservedLegacySummaries
    };
}

/**
 * 요약 데이터 내보내기 (JSON)
 * @returns {string}
 */
export function exportSummaries() {
    const data = getSummaryData();
    const charName = getCharacterName();
    
    const exportData = {
        exportDate: new Date().toISOString(),
        characterName: charName,
        chatId: getCurrentChatId(),
        data: data
    };
    
    return JSON.stringify(exportData, null, 2);
}

/**
 * 요약 데이터 가져오기 (JSON)
 * @param {string} jsonString 
 * @returns {boolean}
 */
export function importSummaries(jsonString) {
    try {
        const importData = JSON.parse(jsonString);
        const data = getSummaryData();
        
        if (!data) {
            return false;
        }
        
        if (importData.data && importData.data.summaries) {
            // 기존 legacySummaries와 characters는 보존하고 summaries만 병합
            for (const [index, summary] of Object.entries(importData.data.summaries)) {
                data.summaries[index] = summary;
            }
            
            data.version = DATA_VERSION;
            data.lastUpdate = new Date().toLocaleString("ko-KR");
            return true;
        }
        
        return false;
    } catch (error) {
        console.error(`[${extensionName}] Import failed:`, error);
        return false;
    }
}

/**
 * 전체 불러오기 (summaries → 요약보기, legacySummaries → 인계된 요약)
 * @param {string} jsonString 
 * @returns {Object} - { success, summaryCount, legacyCount, error }
 */
export function importSummariesFull(jsonString) {
    try {
        const importData = JSON.parse(jsonString);
        const data = getSummaryData();
        
        if (!data) {
            return { success: false, error: 'No chat data' };
        }
        
        let summaryCount = 0;
        let legacyCount = 0;
        let characterCount = 0;
        let eventCount = 0;
        let itemCount = 0;
        
        // summaries 병합
        if (importData.data && importData.data.summaries) {
            for (const [index, summary] of Object.entries(importData.data.summaries)) {
                data.summaries[index] = summary;
                summaryCount++;
            }
        }
        
        // legacySummaries 병합
        if (importData.data && importData.data.legacySummaries && Array.isArray(importData.data.legacySummaries)) {
            if (!data.legacySummaries) {
                data.legacySummaries = [];
            }
            
            // 기존 최대 order 찾기
            const maxOrder = data.legacySummaries.reduce((max, s) => Math.max(max, s.order || 0), -1);
            
            for (let i = 0; i < importData.data.legacySummaries.length; i++) {
                const legacy = importData.data.legacySummaries[i];
                data.legacySummaries.push({
                    ...legacy,
                    order: maxOrder + 1 + i,
                    timestamp: legacy.timestamp || new Date().toISOString(),
                    importedFrom: legacy.importedFrom || 'full-import'
                });
                legacyCount++;
            }
        }
        
        // 등장인물 병합 (firstAppearance 순서로 createdAt 재부여)
        if (importData.data && importData.data.characters && typeof importData.data.characters === 'object') {
            if (!data.characters) {
                data.characters = {};
            }
            
            // firstAppearance 순서대로 정렬 (오름차순: 먼저 등장한 것부터)
            const sortedCharacters = Object.entries(importData.data.characters)
                .sort((a, b) => (a[1].firstAppearance ?? Infinity) - (b[1].firstAppearance ?? Infinity));
            
            const now = Date.now();
            let orderIndex = 0;
            
            for (const [name, character] of sortedCharacters) {
                // 기존 등장인물이 없을 때만 추가 (덮어쓰지 않음)
                if (!data.characters[name]) {
                    data.characters[name] = {
                        ...character,
                        firstAppearance: null,  // 인덱스 종속 필드는 null로
                        // createdAt을 순서대로 부여 (나중에 등장한 캐릭터가 더 큰 값)
                        createdAt: now + orderIndex,
                        lastUpdate: new Date().toISOString()
                    };
                    characterCount++;
                    orderIndex++;
                }
            }
        }
        
        // 이벤트 병합 (messageIndex 순서로 createdAt 재부여)
        if (importData.data && importData.data.events && Array.isArray(importData.data.events)) {
            if (!data.events) {
                data.events = [];
            }
            
            // messageIndex 순서대로 정렬 (오름차순: 먼저 발생한 것부터)
            const sortedEvents = [...importData.data.events]
                .sort((a, b) => (a.messageIndex ?? Infinity) - (b.messageIndex ?? Infinity));
            
            const now = Date.now();
            let orderIndex = 0;
            
            for (const event of sortedEvents) {
                // 동일 ID 체크하여 중복 방지
                const existingIndex = data.events.findIndex(e => e.id === event.id);
                if (existingIndex === -1) {
                    data.events.push({
                        ...event,
                        // createdAt을 순서대로 부여 (나중에 발생한 이벤트가 더 큰 값)
                        createdAt: now + orderIndex,
                        lastUpdate: new Date().toISOString()
                    });
                    eventCount++;
                    orderIndex++;
                }
            }
        }
        
        // 아이템 병합 (messageIndex 순서로 createdAt 재부여)
        if (importData.data && importData.data.items && Array.isArray(importData.data.items)) {
            if (!data.items) {
                data.items = [];
            }
            
            // messageIndex 순서대로 정렬 (오름차순: 먼저 획득한 것부터)
            const sortedItems = [...importData.data.items]
                .sort((a, b) => (a.messageIndex ?? Infinity) - (b.messageIndex ?? Infinity));
            
            const now = Date.now();
            let orderIndex = 0;
            
            for (const item of sortedItems) {
                // 동일 ID 체크하여 중복 방지
                const existingIndex = data.items.findIndex(i => i.id === item.id);
                if (existingIndex === -1) {
                    data.items.push({
                        ...item,
                        // createdAt을 순서대로 부여 (나중에 획득한 아이템이 더 큰 값)
                        createdAt: now + orderIndex,
                        lastUpdate: new Date().toISOString()
                    });
                    itemCount++;
                }
            }
        }
        
        data.lastUpdate = new Date().toLocaleString("ko-KR");
        
        return { success: true, summaryCount, legacyCount, characterCount, eventCount, itemCount };
    } catch (error) {
        console.error(`[${extensionName}] Full import failed:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * 요약 검색 (현재 요약)
 * @param {string} query - 검색어
 * @returns {Array} - [{ messageIndex, content, matches }]
 */
export function searchSummaries(query) {
    const summaries = getRelevantSummaries();
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    for (const [index, summary] of Object.entries(summaries)) {
        const content = String(summary?.content ?? summary ?? '');
        if (content.toLowerCase().includes(lowerQuery)) {
            results.push({
                messageIndex: parseInt(index),
                content: content,
                summary: summary
            });
        }
    }
    
    return results.sort((a, b) => a.messageIndex - b.messageIndex);
}

/**
 * 인계된 요약 검색
 * @param {string} query - 검색어
 * @returns {Array} - [{ order, content }]
 */
export function searchLegacySummaries(query) {
    const legacySummaries = getLegacySummaries();
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    for (const summary of legacySummaries) {
        const content = String(summary?.content ?? '');
        if (content.toLowerCase().includes(lowerQuery)) {
            results.push({
                order: summary.order,
                content: content,
                summary: summary
            });
        }
    }
    
    return results.sort((a, b) => a.order - b.order);
}

// ===== 등장인물 관리 =====

/**
 * 모든 등장인물 가져오기
 * @returns {Object} - { 이름: 캐릭터정보 }
 */
export function getCharacters() {
    const data = getSummaryData();
    return data?.characters || {};
}

/**
 * 현재 채팅 길이 기준으로 유효한 등장인물만 반환 (분기 대응)
 * 마지막 메시지를 초과하는 캐릭터는 제외
 * @returns {Object} - { 이름: 캐릭터정보 }
 */
export function getRelevantCharacters() {
    const context = getContext();
    const currentChatLength = context?.chat?.length || 0;
    const lastMessageIndex = currentChatLength - 1; // 마지막 메시지 인덱스
    const characters = getCharacters();
    
    const relevant = {};
    for (const [name, char] of Object.entries(characters)) {
        // 손상된 데이터 방어
        if (!char || typeof char !== 'object') continue;
        
        // firstAppearance가 없거나 마지막 메시지 이하에 등장한 경우만 포함
        if (char.firstAppearance === null || char.firstAppearance === undefined || char.firstAppearance <= lastMessageIndex) {
            relevant[name] = char;
        }
    }
    
    return relevant;
}

/**
 * 특정 등장인물 가져오기
 * @param {string} name - 캐릭터 이름
 * @returns {Object|null}
 */
export function getCharacter(name) {
    const data = getSummaryData();
    return data?.characters?.[name] || null;
}

/**
 * 등장인물 추가/업데이트
 * @param {string} name - 캐릭터 이름
 * @param {Object} info - 캐릭터 정보
 * @returns {Object} - 저장된 캐릭터 객체
 */
export function setCharacter(name, info) {
    const data = getSummaryData();
    if (!data) return null;
    
    if (!data.characters) {
        data.characters = {};
    }
    
    const existing = data.characters[name] || {};
    
    const character = {
        name: name,
        role: info.role ?? existing.role ?? '',              // AI가 자유롭게 생성 (예: "주인공의 동료", "마을 상인")
        age: info.age ?? existing.age ?? '',                 // 나이 (예: "20대 초반", "불명")
        occupation: info.occupation ?? existing.occupation ?? '',  // 직업
        description: info.description ?? existing.description ?? '',
        traits: info.traits ?? existing.traits ?? [],        // 성격/특성 배열
        relationshipWithUser: info.relationshipWithUser ?? existing.relationshipWithUser ?? '',  // {{user}}와의 관계
        firstAppearance: info.firstAppearance ?? existing.firstAppearance ?? null,
        lastUpdate: new Date().toISOString()
    };
    
    data.characters[name] = character;
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return character;
}

/**
 * 등장인물 삭제
 * @param {string} name - 캐릭터 이름
 */
export function deleteCharacter(name) {
    const data = getSummaryData();
    if (!data || !data.characters) return;
    
    delete data.characters[name];
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * 모든 등장인물 삭제 (데이터만 삭제)
 */
export function clearCharactersData() {
    const data = getSummaryData();
    if (!data) return;
    
    data.characters = {};
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * AI 응답에서 등장인물 정보 추출하여 저장/업데이트
 * @param {Object} extractedCharacters - { 이름: { role, age, occupation, description, traits, relationshipWithUser, firstAppearance } }
 * @param {number} fallbackMessageIndex - AI가 firstAppearance를 반환하지 않은 경우 사용할 폴백 인덱스
 */
export function mergeExtractedCharacters(extractedCharacters, fallbackMessageIndex) {
    const data = getSummaryData();
    if (!data) return;
    
    if (!data.characters) {
        data.characters = {};
    }
    
    for (const [name, info] of Object.entries(extractedCharacters)) {
        const existing = data.characters[name];
        
        if (existing) {
            // 기존 캐릭터 업데이트 - 확실한 변경이 있을 때만 덮어쓰기
            // 빈 값이 아니고, 기존 값과 다를 때만 업데이트
            let hasChanges = false;
            
            if (info.role && info.role !== existing.role) {
                existing.role = info.role;
                hasChanges = true;
            }
            if (info.age && info.age !== existing.age) {
                existing.age = info.age;
                hasChanges = true;
            }
            if (info.occupation && info.occupation !== existing.occupation) {
                existing.occupation = info.occupation;
                hasChanges = true;
            }
            if (info.description && info.description !== existing.description) {
                existing.description = info.description;
                hasChanges = true;
            }
            if (info.relationshipWithUser && info.relationshipWithUser !== existing.relationshipWithUser) {
                existing.relationshipWithUser = info.relationshipWithUser;
                hasChanges = true;
            }
            
            // traits: 새 traits가 있고 기존과 다르면 교체 (최대 10개)
            if (info.traits && info.traits.length > 0) {
                const newTraits = info.traits.slice(0, 10);
                const existingTraitsStr = (existing.traits || []).join(',');
                const newTraitsStr = newTraits.join(',');
                if (newTraitsStr !== existingTraitsStr) {
                    existing.traits = newTraits;
                    hasChanges = true;
                }
            }
            
            if (hasChanges) {
                existing.lastUpdate = new Date().toISOString();
            }
        } else {
            // 새 캐릭터 추가 (traits 최대 10개)
            // AI가 반환한 firstAppearance가 있으면 사용, 없으면 fallback
            const charFirstAppearance = (info.firstAppearance !== null && info.firstAppearance !== undefined)
                ? info.firstAppearance
                : fallbackMessageIndex;
            
            data.characters[name] = {
                name: name,
                role: info.role || '',
                age: info.age || '',
                occupation: info.occupation || '',
                description: info.description || '',
                traits: (info.traits || []).slice(0, 10),
                relationshipWithUser: info.relationshipWithUser || '',
                firstAppearance: charFirstAppearance,
                lastUpdate: new Date().toISOString()
            };
        }
    }
    
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * 등장인물 정보를 텍스트로 포맷 (AI 컨텍스트용)
 * @param {boolean} forAI - AI 프롬프트용 간결한 형식 여부
 * @returns {string}
 */
export function formatCharactersText(forAI = false) {
    const charactersObj = getRelevantCharacters();
    const characters = Object.values(charactersObj);
    
    if (characters.length === 0) {
        return forAI ? "" : "No registered characters.";
    }
    
    let text = "";
    for (const char of characters.sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        if (forAI) {
            // AI용 간결한 형식
            let line = `- ${char.name}`;
            const details = [];
            if (char.role) details.push(char.role);
            if (char.age) details.push(char.age);
            if (char.occupation) details.push(char.occupation);
            if (details.length > 0) line += ` (${details.join(', ')})`;
            if (char.relationshipWithUser) line += ` [Relationship with {{user}}: ${char.relationshipWithUser}]`;
            // AI 형식에 특성 및 설명 필드 추가
            if (char.traits && char.traits.length > 0) {
                line += ` [Traits: ${char.traits.join(', ')}]`;
            }
            if (char.description) {
                line += ` [Description: ${char.description}]`;
            }
            text += line + "\n";
        } else {
            // UI용 상세 형식
            text += `【${char.name}】\n`;
            if (char.role) text += `  역할: ${char.role}\n`;
            if (char.age) text += `  나이: ${char.age}\n`;
            if (char.occupation) text += `  직업: ${char.occupation}\n`;
            if (char.description) text += `  설명: ${char.description}\n`;
            if (char.traits && char.traits.length > 0) {
                text += `  특성: ${char.traits.join(', ')}\n`;
            }
            if (char.relationshipWithUser) {
                text += `  {{user}}와의 관계: ${char.relationshipWithUser}\n`;
            }
            if (char.firstAppearance !== null) {
                text += `  첫 등장: #${char.firstAppearance}\n`;
            }
            text += "\n";
        }
    }
    
    return text.trim();
}

/**
 * 요약 시 참조할 이전 요약 텍스트 가져오기 (일관성 유지용)
 * 현재 채팅방 요약 + 인계된 요약 모두 참조
 * @param {number} beforeIndex - 이 인덱스 이전의 요약만 가져옴
 * @param {number} count - 가져올 요약 수 (0 = 없음, -1 = 전체)
 * @returns {string} - 이전 요약들을 합친 텍스트
 */
export function getRecentSummariesForContext(beforeIndex, count) {
    if (count === 0) {
        return '';
    }
    
    const data = getSummaryData();
    if (!data) {
        return '';
    }
    
    // 시간순 정렬을 위한 가상 타임스탬프 계산
    // 인계된 요약: 0 ~ (legacyCount - 1)
    // 현재 요약: legacyCount + messageIndex
    const legacyCount = data.legacySummaries?.length || 0;
    
    const allSummaries = [];
    
    // 1. 인계된 요약 수집 (이전 채팅방 = 더 오래전)
    if (data.legacySummaries && Array.isArray(data.legacySummaries)) {
        for (const legacy of data.legacySummaries) {
            const content = String(legacy.content ?? '');
            if (content) {
                allSummaries.push({
                    // order가 작을수록 오래된 것
                    timeOrder: legacy.order,
                    content: content,
                    isLegacy: true
                });
            }
        }
    }
    
    // 2. 현재 채팅방 요약 수집 (beforeIndex 이전만)
    if (data.summaries) {
        const prevIndices = Object.keys(data.summaries)
            .map(Number)
            .filter(i => i < beforeIndex);
        
        for (const idx of prevIndices) {
            const summary = data.summaries[idx];
            const content = String(summary?.content ?? summary ?? '');
            // 그룹 요약에 포함된 항목 제외
            if (!content.startsWith('[→') && !content.includes('그룹 요약에 포함')) {
                allSummaries.push({
                    // 현재 요약은 인계 요약보다 나중 (legacyCount를 더해서 순서 보장)
                    timeOrder: legacyCount + idx,
                    content: content,
                    isLegacy: false
                });
            }
        }
    }
    
    if (allSummaries.length === 0) {
        return '';
    }
    
    // 3. 시간순 내림차순 정렬 (최신이 먼저)
    allSummaries.sort((a, b) => b.timeOrder - a.timeOrder);
    
    // 4. count가 -1이면 전체, 아니면 지정된 수만큼 (최신부터)
    const toUse = count === -1 
        ? allSummaries 
        : allSummaries.slice(0, count);
    
    // 5. AI에게 보낼 때는 오래된 것부터 (자연스러운 읽기 순서)
    toUse.sort((a, b) => a.timeOrder - b.timeOrder);
    
    const summaryTexts = toUse.map(s => s.content);
    
    return summaryTexts.join('\n\n');
}

/**
 * 가장 최근 요약에서 컨텍스트 상태 추출
 * @param {number} beforeIndex - 이 인덱스 이전의 요약에서 추출
 * @returns {Object} - { time, location, relationship }
 */
export function getPreviousContext(beforeIndex) {
    const data = getSummaryData();
    if (!data || !data.summaries) {
        return { time: '불명', location: '불명', relationship: '불명' };
    }
    
    // beforeIndex보다 작은 인덱스 중 가장 큰 것 찾기
    const prevIndices = Object.keys(data.summaries)
        .map(Number)
        .filter(i => i < beforeIndex)
        .sort((a, b) => b - a);
    
    if (prevIndices.length === 0) {
        return { time: '불명', location: '불명', relationship: '불명' };
    }
    
    // 최신 요약부터 역순으로 순회하며 유효한 값 찾기
    let time = '불명';
    let location = '불명';
    let relationship = '불명';
    
    for (const idx of prevIndices) {
        const summary = data.summaries[idx];
        const content = String(summary?.content ?? summary ?? '');
        
        if (time === '불명') {
            const timeMatch = content.match(/\* 시간[：:]\s*(.+)/);
            if (timeMatch && !timeMatch[1].includes('동일') && !timeMatch[1].includes('불명')) {
                time = timeMatch[1].trim();
            }
        }
        
        if (location === '불명') {
            const locMatch = content.match(/\* 장소[：:]\s*(.+)/);
            if (locMatch && !locMatch[1].includes('동일') && !locMatch[1].includes('불명')) {
                location = locMatch[1].trim();
            }
        }
        
        if (relationship === '불명') {
            const relMatch = content.match(/\* 관계[：:]\s*(.+)/);
            if (relMatch && !relMatch[1].includes('없음') && !relMatch[1].includes('불명')) {
                relationship = relMatch[1].trim();
            }
        }
        
        // 모두 찾았으면 종료
        if (time !== '불명' && location !== '불명' && relationship !== '불명') {
            break;
        }
    }
    
    return { time, location, relationship };
}

// ===== 인계된 요약 (Legacy Summaries) 관리 =====

/**
 * 인계된 요약 가져오기
 * @returns {Array} - 인계된 요약 배열
 */
export function getLegacySummaries() {
    const data = getSummaryData();
    if (!data) return [];
    
    if (!data.legacySummaries || !Array.isArray(data.legacySummaries)) {
        data.legacySummaries = [];
    }
    
    return data.legacySummaries;
}

/**
 * 인계된 요약 추가
 * @param {string} content - 요약 내용
 * @param {Object} metadata - 추가 메타데이터 (optional)
 * @returns {Object} - 추가된 요약 객체
 */
export function addLegacySummary(content, metadata = {}) {
    const data = getSummaryData();
    if (!data) return null;
    
    if (!data.legacySummaries || !Array.isArray(data.legacySummaries)) {
        data.legacySummaries = [];
    }
    
    // 새 order 계산 (가장 큰 order + 1)
    const maxOrder = data.legacySummaries.reduce((max, s) => Math.max(max, s.order || 0), -1);
    
    const summary = {
        order: maxOrder + 1,
        content: content,
        timestamp: new Date().toISOString(),
        importedFrom: metadata.importedFrom || 'unknown',
        originalIndex: metadata.originalIndex ?? null,
        ...metadata
    };
    
    data.legacySummaries.push(summary);
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return summary;
}

/**
 * 인계된 요약 수정
 * @param {number} order - 수정할 요약의 order
 * @param {string} newContent - 새 내용
 * @returns {boolean} - 성공 여부
 */
export function updateLegacySummary(order, newContent) {
    const data = getSummaryData();
    if (!data || !data.legacySummaries) return false;
    
    const summary = data.legacySummaries.find(s => s.order === order);
    if (!summary) return false;
    
    summary.content = newContent;
    summary.lastModified = new Date().toISOString();
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return true;
}

/**
 * 인계된 요약 삭제
 * @param {number} order - 삭제할 요약의 order
 * @returns {boolean} - 성공 여부
 */
export function deleteLegacySummary(order) {
    const data = getSummaryData();
    if (!data || !data.legacySummaries) return false;
    
    const index = data.legacySummaries.findIndex(s => s.order === order);
    if (index === -1) return false;
    
    data.legacySummaries.splice(index, 1);
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return true;
}

/**
 * 인계된 요약 전체 삭제
 */
export function clearLegacySummaries() {
    const data = getSummaryData();
    if (!data) return;
    
    data.legacySummaries = [];
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * 요약 파일을 인계된 요약으로 가져오기
 * @param {string} jsonString - JSON 문자열
 * @returns {Object} - { success, count, error }
 */
export function importAsLegacySummaries(jsonString) {
    try {
        const importData = JSON.parse(jsonString);
        const data = getSummaryData();
        
        if (!data) {
            return { success: false, count: 0, error: '요약 데이터 초기화 실패' };
        }
        
        if (!data.legacySummaries || !Array.isArray(data.legacySummaries)) {
            data.legacySummaries = [];
        }
        
        // 가져올 요약 데이터 확인 (summaries 또는 legacySummaries 중 하나라도 있어야 함)
        const sourceSummaries = importData.data?.summaries;
        const sourceLegacySummaries = importData.data?.legacySummaries;
        
        const hasSummaries = sourceSummaries && Object.keys(sourceSummaries).length > 0;
        const hasLegacySummaries = sourceLegacySummaries && Array.isArray(sourceLegacySummaries) && sourceLegacySummaries.length > 0;
        
        if (!hasSummaries && !hasLegacySummaries) {
            return { success: false, count: 0, error: '가져올 요약이 없습니다' };
        }
        
        // 현재 최대 order 계산
        let maxOrder = data.legacySummaries.reduce((max, s) => Math.max(max, s.order || 0), -1);
        let addedCount = 0;
        
        // 1단계: 원본의 legacySummaries를 먼저 가져오기 (A채팅방의 인계된 요약)
        if (hasLegacySummaries) {
            // order 순으로 정렬하여 순서 유지
            const sortedLegacy = [...sourceLegacySummaries].sort((a, b) => (a.order || 0) - (b.order || 0));
            
            for (const legacySummary of sortedLegacy) {
                const content = String(legacySummary?.content ?? '');
                
                // 빈 내용 건너뛰기
                if (!content.trim()) {
                    continue;
                }
                
                maxOrder++;
                data.legacySummaries.push({
                    order: maxOrder,
                    content: content,
                    timestamp: legacySummary?.timestamp || new Date().toISOString(),
                    importedFrom: legacySummary?.importedFrom || importData.characterName || 'imported',
                    originalIndex: legacySummary?.originalIndex,
                    importDate: new Date().toISOString()
                });
                addedCount++;
            }
        }
        
        // 2단계: 원본의 summaries를 가져오기 (B채팅방의 현재 요약)
        if (hasSummaries) {
            // 인덱스 순으로 정렬하여 순서대로 추가
            const indices = Object.keys(sourceSummaries).map(Number).sort((a, b) => a - b);
            
            for (const idx of indices) {
                const summary = sourceSummaries[idx];
                const content = String(summary?.content ?? summary ?? '');
                
                // 그룹 요약에 포함된 항목은 건너뛰기
                if (content.startsWith('[→') || content.includes('그룹 요약에 포함')) {
                    continue;
                }
                
                maxOrder++;
                data.legacySummaries.push({
                    order: maxOrder,
                    content: content,
                    timestamp: summary?.timestamp || new Date().toISOString(),
                    importedFrom: importData.characterName || 'imported',
                    originalIndex: idx,
                    importDate: new Date().toISOString()
                });
                addedCount++;
            }
        }
        
        // 등장인물 정보 불러오기 (firstAppearance 순서로 createdAt 재부여)
        let characterCount = 0;
        if (importData.data?.characters && typeof importData.data.characters === 'object') {
            if (!data.characters) {
                data.characters = {};
            }
            
            // firstAppearance 순서대로 정렬 (오름차순: 먼저 등장한 것부터)
            const sortedCharacters = Object.entries(importData.data.characters)
                .sort((a, b) => (a[1].firstAppearance ?? Infinity) - (b[1].firstAppearance ?? Infinity));
            
            const now = Date.now();
            let orderIndex = 0;
            
            for (const [name, character] of sortedCharacters) {
                // 기존 등장인물이 없을 때만 추가 (덮어쓰지 않음)
                if (!data.characters[name]) {
                    data.characters[name] = {
                        ...character,
                        firstAppearance: null,  // 인덱스 종속 필드는 null로
                        // createdAt을 순서대로 부여 (나중에 등장한 캐릭터가 더 큰 값)
                        createdAt: now + orderIndex,
                        lastUpdate: new Date().toISOString()
                    };
                    characterCount++;
                    orderIndex++;
                }
            }
        }
        
        // 이벤트 정보 불러오기 (messageIndex 순서로 createdAt 재부여)
        let eventCount = 0;
        if (importData.data?.events && Array.isArray(importData.data.events)) {
            if (!data.events) {
                data.events = [];
            }
            
            // messageIndex 순서대로 정렬 (오름차순: 먼저 발생한 것부터)
            const sortedEvents = [...importData.data.events]
                .sort((a, b) => (a.messageIndex ?? Infinity) - (b.messageIndex ?? Infinity));
            
            const now = Date.now();
            let orderIndex = 0;
            
            for (const event of sortedEvents) {
                // 동일 ID 또는 동일 제목 체크하여 중복 방지
                const existingById = data.events.find(e => e.id === event.id);
                const existingByTitle = data.events.find(e => e.title === event.title);
                if (!existingById && !existingByTitle) {
                    data.events.push({
                        ...event,
                        id: event.id || `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        messageIndex: null,  // 인덱스 종속 필드는 null로
                        // createdAt을 순서대로 부여 (나중에 발생한 이벤트가 더 큰 값)
                        createdAt: now + orderIndex,
                        lastUpdate: new Date().toISOString()
                    });
                    eventCount++;
                    orderIndex++;
                }
            }
        }
        
        // 아이템 정보 불러오기 (messageIndex 순서로 createdAt 재부여)
        let itemCount = 0;
        if (importData.data?.items && Array.isArray(importData.data.items)) {
            if (!data.items) {
                data.items = [];
            }
            
            // messageIndex 순서대로 정렬 (오름차순: 먼저 획득한 것부터)
            const sortedItems = [...importData.data.items]
                .sort((a, b) => (a.messageIndex ?? Infinity) - (b.messageIndex ?? Infinity));
            
            const now = Date.now();
            let orderIndex = 0;
            
            for (const item of sortedItems) {
                // 동일 ID 또는 동일 이름 체크하여 중복 방지
                const existingById = data.items.find(i => i.id === item.id);
                const existingByName = data.items.find(i => i.name === item.name);
                if (!existingById && !existingByName) {
                    data.items.push({
                        ...item,
                        id: item.id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        messageIndex: null,  // 인덱스 종속 필드는 null로
                        // createdAt을 순서대로 부여 (나중에 획득한 아이템이 더 큰 값)
                        createdAt: now + orderIndex,
                        lastUpdate: new Date().toISOString()
                    });
                    itemCount++;
                    orderIndex++;
                }
            }
        }
        
        data.lastUpdate = new Date().toLocaleString("ko-KR");
        
        return { 
            success: true, 
            count: addedCount,
            characterCount: characterCount,
            eventCount: eventCount,
            itemCount: itemCount,
            characterName: importData.characterName || 'unknown'
        };
    } catch (error) {
        console.error(`[${extensionName}] Legacy import failed:`, error);
        return { success: false, count: 0, error: error.message };
    }
}

/**
 * 인계된 요약 내보내기
 * @returns {string} - JSON 문자열
 */
export function exportLegacySummaries() {
    const data = getSummaryData();
    const charName = getCharacterName();
    
    const exportData = {
        exportDate: new Date().toISOString(),
        characterName: charName,
        type: 'legacy_summaries',
        legacySummaries: data?.legacySummaries || []
    };
    
    return JSON.stringify(exportData, null, 2);
}

/**
 * 인계된 요약 총 토큰 수 추정 (간단한 추정)
 * @returns {number} - 추정 토큰 수
 */
export function estimateLegacyTokens() {
    const legacySummaries = getLegacySummaries();
    let totalChars = 0;
    
    for (const summary of legacySummaries) {
        const content = String(summary?.content ?? '');
        totalChars += content.length;
    }
    
    // 간단한 추정: 한글 2자당 1토큰, 영문 4자당 1토큰 (평균)
    return Math.ceil(totalChars / 3);
}

// ===== 이벤트 관리 함수 =====

/**
 * 모든 이벤트 가져오기
 * @returns {Array}
 */
export function getEvents() {
    const data = getSummaryData();
    if (!data) return [];
    if (!data.events) data.events = [];
    return data.events;
}

/**
 * 현재 채팅 길이 기준으로 유효한 이벤트만 반환 (분기 대응)
 * 마지막 메시지를 초과하는 이벤트는 제외
 * @returns {Array}
 */
export function getRelevantEvents() {
    const context = getContext();
    const currentChatLength = context?.chat?.length || 0;
    const lastMessageIndex = currentChatLength - 1; // 마지막 메시지 인덱스
    const events = getEvents();
    
    return events.filter(event => {
        // 손상된 데이터 방어
        if (!event || typeof event !== 'object') return false;
        
        // messageIndex가 없거나 마지막 메시지 이하에 발생한 경우만 포함
        return event.messageIndex === null || event.messageIndex === undefined || event.messageIndex <= lastMessageIndex;
    });
}

/**
 * 특정 이벤트 가져오기
 * @param {string} eventId - 이벤트 ID
 * @returns {Object|null}
 */
export function getEvent(eventId) {
    const events = getEvents();
    return events.find(e => e.id === eventId) || null;
}

/**
 * 이벤트 추가
 * @param {Object} eventData - 이벤트 데이터
 * @returns {Object} - 추가된 이벤트
 */
export function addEvent(eventData) {
    const data = getSummaryData();
    if (!data) return null;
    if (!data.events) data.events = [];
    
    const newEvent = {
        id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        title: eventData.title || '제목 없음',
        description: eventData.description || '',
        messageIndex: eventData.messageIndex || null,
        participants: eventData.participants || [],
        importance: eventData.importance || 'medium',
        tags: eventData.tags || [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    
    data.events.push(newEvent);
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return newEvent;
}

/**
 * 이벤트 수정
 * @param {string} eventId - 이벤트 ID
 * @param {Object} updates - 수정할 필드들
 * @returns {boolean}
 */
export function updateEvent(eventId, updates) {
    const data = getSummaryData();
    if (!data || !data.events) return false;
    
    const index = data.events.findIndex(e => e.id === eventId);
    if (index === -1) return false;
    
    data.events[index] = {
        ...data.events[index],
        ...updates,
        updatedAt: Date.now()
    };
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return true;
}

/**
 * 이벤트 삭제
 * @param {string} eventId - 이벤트 ID
 * @returns {boolean}
 */
export function deleteEvent(eventId) {
    const data = getSummaryData();
    if (!data || !data.events) return false;
    
    const index = data.events.findIndex(e => e.id === eventId);
    if (index === -1) return false;
    
    data.events.splice(index, 1);
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return true;
}

/**
 * 모든 이벤트 삭제
 */
export function clearEvents() {
    const data = getSummaryData();
    if (!data) return;
    data.events = [];
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

// ===== 아이템 관리 함수 =====

/**
 * 모든 아이템 가져오기
 * @returns {Array}
 */
export function getItems() {
    const data = getSummaryData();
    if (!data) return [];
    if (!data.items) data.items = [];
    return data.items;
}

/**
 * 현재 채팅 길이 기준으로 유효한 아이템만 반환 (분기 대응)
 * 마지막 메시지를 초과하는 아이템은 제외
 * @returns {Array}
 */
export function getRelevantItems() {
    const context = getContext();
    const currentChatLength = context?.chat?.length || 0;
    const lastMessageIndex = currentChatLength - 1; // 마지막 메시지 인덱스
    const items = getItems();
    
    return items.filter(item => {
        // 손상된 데이터 방어
        if (!item || typeof item !== 'object') return false;
        
        // messageIndex가 없거나 마지막 메시지 이하에 획득한 경우만 포함
        return item.messageIndex === null || item.messageIndex === undefined || item.messageIndex <= lastMessageIndex;
    });
}

/**
 * 특정 아이템 가져오기
 * @param {string} itemId - 아이템 ID
 * @returns {Object|null}
 */
export function getItem(itemId) {
    const items = getItems();
    return items.find(i => i.id === itemId) || null;
}

/**
 * 아이템 추가 (같은 이름의 아이템이 있으면 상태만 업데이트)
 * @param {Object} itemData - 아이템 데이터
 * @returns {Object} - 추가/업데이트된 아이템
 */
export function addItem(itemData) {
    const data = getSummaryData();
    if (!data) return null;
    if (!data.items) data.items = [];
    
    // 같은 이름의 아이템이 이미 있는지 확인
    const existingIndex = data.items.findIndex(item => 
        item.name && itemData.name && 
        item.name.toLowerCase().trim() === itemData.name.toLowerCase().trim()
    );
    
    if (existingIndex !== -1) {
        // 기존 아이템이 있으면 상태만 업데이트 (확실한 변경만)
        const existing = data.items[existingIndex];
        if (itemData.status && itemData.status !== existing.status) {
            existing.status = itemData.status;
            existing.updatedAt = Date.now();
            // messageIndex 업데이트 (더 최신 위치로)
            if (itemData.messageIndex && (!existing.messageIndex || itemData.messageIndex > existing.messageIndex)) {
                existing.messageIndex = itemData.messageIndex;
            }
            data.lastUpdate = new Date().toLocaleString("ko-KR");
        }
        return existing;
    }
    
    // 새 아이템 추가
    const newItem = {
        id: `itm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: itemData.name || '이름 없음',
        description: itemData.description || '',
        owner: itemData.owner || '',
        origin: itemData.origin || '',
        status: itemData.status || '보유중',
        messageIndex: itemData.messageIndex || null,
        acquiredAt: itemData.acquiredAt || null,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    
    data.items.push(newItem);
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return newItem;
}

/**
 * 아이템 수정
 * @param {string} itemId - 아이템 ID
 * @param {Object} updates - 수정할 필드들
 * @returns {boolean}
 */
export function updateItem(itemId, updates) {
    const data = getSummaryData();
    if (!data || !data.items) return false;
    
    const index = data.items.findIndex(i => i.id === itemId);
    if (index === -1) return false;
    
    data.items[index] = {
        ...data.items[index],
        ...updates,
        updatedAt: Date.now()
    };
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return true;
}

/**
 * 아이템 삭제
 * @param {string} itemId - 아이템 ID
 * @returns {boolean}
 */
export function deleteItem(itemId) {
    const data = getSummaryData();
    if (!data || !data.items) return false;
    
    const index = data.items.findIndex(i => i.id === itemId);
    if (index === -1) return false;
    
    data.items.splice(index, 1);
    data.lastUpdate = new Date().toLocaleString("ko-KR");
    
    return true;
}

/**
 * 모든 아이템 삭제
 */
export function clearItems() {
    const data = getSummaryData();
    if (!data) return;
    data.items = [];
    data.lastUpdate = new Date().toLocaleString("ko-KR");
}

/**
 * 이벤트/아이템 포함하여 내보내기 데이터 생성
 * @param {string} mode - 'current', 'legacy', 'all'
 * @returns {Object}
 */
export function exportDataWithEventsItems(mode = 'all') {
    const data = getSummaryData();
    const charName = getCharacterName();
    
    const exportData = {
        exportDate: new Date().toISOString(),
        characterName: charName,
        type: mode === 'all' ? 'full_export' : mode,
        version: DATA_VERSION
    };
    
    if (mode === 'current' || mode === 'all') {
        exportData.summaries = data?.summaries || {};
    }
    if (mode === 'legacy' || mode === 'all') {
        exportData.legacySummaries = data?.legacySummaries || [];
    }
    if (mode === 'all') {
        exportData.characters = data?.characters || {};
        exportData.events = data?.events || [];
        exportData.items = data?.items || [];
    }
    
    return exportData;
}

/**
 * 이벤트/아이템 포함하여 가져오기
 * @param {Object} importData - 가져올 데이터
 * @param {string} mode - 'merge', 'legacy', 'full'
 * @returns {Object} - { success, counts }
 */
export function importDataWithEventsItems(importData, mode = 'full') {
    try {
        const data = getSummaryData();
        if (!data) return { success: false, error: 'No data context' };
        
        let counts = {
            summaries: 0,
            legacySummaries: 0,
            characters: 0,
            events: 0,
            items: 0
        };
        
        if (mode === 'full') {
            // 전체 복원
            if (importData.summaries) {
                data.summaries = importData.summaries;
                counts.summaries = Object.keys(importData.summaries).length;
            }
            if (importData.legacySummaries) {
                data.legacySummaries = importData.legacySummaries;
                counts.legacySummaries = importData.legacySummaries.length;
            }
            if (importData.characters) {
                data.characters = importData.characters;
                counts.characters = Object.keys(importData.characters).length;
            }
            if (importData.events) {
                data.events = importData.events;
                counts.events = importData.events.length;
            }
            if (importData.items) {
                data.items = importData.items;
                counts.items = importData.items.length;
            }
        }
        
        data.lastUpdate = new Date().toLocaleString("ko-KR");
        
        return { success: true, counts };
    } catch (error) {
        console.error(`[${extensionName}] Import failed:`, error);
        return { success: false, error: error.message };
    }
}
