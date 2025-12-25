/**
 * 시나리오 자동요약 - 데이터 저장/로드
 */

import { getContext, extension_settings } from "../../../../extensions.js";
import { saveChatConditional } from "../../../../../script.js";
import { extensionName, METADATA_KEY, DATA_VERSION } from './constants.js';
import { log, getSettings } from './state.js';'./state.js';

/**
 * 요약 데이터 가져오기 (없으면 초기화)
 * @returns {Object|null}
 */
export function getSummaryData() {
    const context = getContext();
    if (!context) {
        log('getContext() returned null');
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
        log('Data migrated to version ' + DATA_VERSION);
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
        characters: {},             // 캐릭터 이름 -> 캐릭터 정보 객체
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
        // 이미 summaries 형태면 버전만 업데이트
        if (oldData.summaries) {
            newData.summaries = oldData.summaries;
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
        log('Summary data saved');
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
 * @returns {Object} - { 인덱스: 요약객체 }
 */
export function getRelevantSummaries() {
    const context = getContext();
    const currentChatLength = context?.chat?.length || 0;
    const data = getSummaryData();
    
    if (!data || !data.summaries) {
        return {};
    }
    
    const relevant = {};
    for (const [index, summary] of Object.entries(data.summaries)) {
        const idx = parseInt(index);
        if (idx < currentChatLength) {
            relevant[index] = summary;
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
    
    delete data.summaries[messageIndex];
    
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
    
    context.chatMetadata[METADATA_KEY] = createEmptyData();
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
        const context = getContext();
        
        if (!context?.chatMetadata) {
            return false;
        }
        
        if (importData.data && importData.data.summaries) {
            context.chatMetadata[METADATA_KEY] = {
                ...createEmptyData(),
                ...importData.data,
                version: DATA_VERSION,
                lastUpdate: new Date().toLocaleString("ko-KR")
            };
            return true;
        }
        
        return false;
    } catch (error) {
        console.error(`[${extensionName}] Import failed:`, error);
        return false;
    }
}

/**
 * 요약 검색
 * @param {string} query - 검색어
 * @returns {Array} - [{ messageIndex, content, matches }]
 */
export function searchSummaries(query) {
    const summaries = getRelevantSummaries();
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    for (const [index, summary] of Object.entries(summaries)) {
        const content = summary.content || '';
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
 * AI 응답에서 등장인물 정보 추출하여 저장/업데이트
 * @param {Object} extractedCharacters - { 이름: { role, age, occupation, description, traits, relationshipWithUser } }
 * @param {number} messageIndex - 첫 등장 메시지 인덱스
 */
export function mergeExtractedCharacters(extractedCharacters, messageIndex) {
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
            data.characters[name] = {
                name: name,
                role: info.role || '',
                age: info.age || '',
                occupation: info.occupation || '',
                description: info.description || '',
                traits: (info.traits || []).slice(0, 10),
                relationshipWithUser: info.relationshipWithUser || '',
                firstAppearance: messageIndex,
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
    const characters = getRelevantCharacters();
    
    if (characters.length === 0) {
        return forAI ? "" : "No registered characters.";
    }
    
    let text = "";
    for (const char of characters.sort((a, b) => a.name.localeCompare(b.name))) {
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
 * 현재 채팅 길이 기준으로 유효한 등장인물만 반환
 * @returns {Array} - 캐릭터 객체 배열
 */
export function getRelevantCharacters() {
    const context = getContext();
    const currentChatLength = context?.chat?.length || 0;
    const characters = getCharacters();
    
    return Object.values(characters).filter(char => {
        // firstAppearance가 null이면 수동 추가된 것이므로 포함
        if (char.firstAppearance === null) return true;
        // 현재 채팅 길이보다 작은 인덱스에서 등장한 캐릭터만
        return char.firstAppearance < currentChatLength;
    });
}

/**
 * 요약 시 참조할 이전 요약 텍스트 가져오기 (일관성 유지용)
 * @param {number} beforeIndex - 이 인덱스 이전의 요약만 가져옴
 * @param {number} count - 가져올 요약 수 (0 = 없음, -1 = 전체)
 * @returns {string} - 이전 요약들을 합친 텍스트
 */
export function getRecentSummariesForContext(beforeIndex, count) {
    if (count === 0) {
        return '';
    }
    
    const data = getSummaryData();
    if (!data || !data.summaries) {
        return '';
    }
    
    // beforeIndex보다 작은 인덱스들을 내림차순 정렬
    const prevIndices = Object.keys(data.summaries)
        .map(Number)
        .filter(i => i < beforeIndex)
        .sort((a, b) => b - a);
    
    if (prevIndices.length === 0) {
        return '';
    }
    
    // count가 -1이면 전체, 아니면 지정된 수만큼
    const indicesToUse = count === -1 
        ? prevIndices 
        : prevIndices.slice(0, count);
    
    // 오래된 것부터 최신 순으로 정렬 (프롬프트에 자연스럽게 표시)
    indicesToUse.sort((a, b) => a - b);
    
    // 그룹 요약에 포함된 항목 제외
    const summaryTexts = indicesToUse
        .filter(idx => {
            const content = data.summaries[idx]?.content || '';
            return !content.startsWith('[→') && !content.includes('그룹 요약에 포함');
        })
        .map(idx => {
            const content = data.summaries[idx]?.content || '';
            return content;
        });
    
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
        const content = data.summaries[idx]?.content || '';
        
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
