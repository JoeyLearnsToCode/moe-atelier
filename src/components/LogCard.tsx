import React from 'react';
import { Typography, Space } from 'antd';
import {
  CloseCircleFilled,
  FileTextOutlined,
} from '@ant-design/icons';
import type { LogEntry } from '../types/log';
const { Text } = Typography;

const MAX_LOG = 30;

interface LogCardProps {
  entries: LogEntry[];
}

const LogCard: React.FC<LogCardProps> = ({ entries }) => {
  const displayEntries = entries.slice(0, MAX_LOG);

  return (
    <div
      className="moe-card"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{
        padding: '12px 16px',
        borderBottom: '2px dashed #FFF0F3',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: '#fff',
      }}>
        <div style={{
          width: 28, height: 28,
          background: '#FFF0F3',
          borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#FF9EB5',
        }}>
          <FileTextOutlined style={{ fontSize: 14 }} />
        </div>
        <Text strong style={{ fontSize: 14, color: '#665555' }}>任务日志</Text>
        {entries.length > 0 && (
          <div style={{
            background: '#FFF0F3',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 11,
            color: '#FF9EB5',
            fontWeight: 700,
            marginLeft: 'auto',
          }}>
            {entries.length > MAX_LOG ? `${MAX_LOG}+` : entries.length}
          </div>
        )}
      </div>

      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px 0',
      }}>
        {displayEntries.length === 0 ? (
          <div style={{
            height: '100%',
            minHeight: 200,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: '#D0C0C0',
            padding: '40px 0',
          }}>
            <FileTextOutlined style={{ fontSize: 28, opacity: 0.5 }} />
            <Text type="secondary" style={{ fontSize: 13 }}>暂无日志</Text>
          </div>
        ) : (
          <Space direction="vertical" size={0} style={{ width: '100%' }}>
            {displayEntries.map((entry) => (
              <div
                key={entry.id}
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid #FFF0F3',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CloseCircleFilled style={{ color: '#FF8FA3', fontSize: 12, flexShrink: 0 }} />
                  <Text
                    code
                    style={{
                      fontSize: 11,
                      color: '#998888',
                      fontFamily: 'monospace',
                      background: '#FFF5F7',
                      padding: '1px 6px',
                      borderRadius: 4,
                      border: '1px solid #FFE5EA',
                    }}
                  >
                    #{entry.taskId.slice(0, 6).toUpperCase()}
                  </Text>
                  <Text style={{
                    fontSize: 10,
                    color: '#D0C0C0',
                    marginLeft: 'auto',
                    flexShrink: 0,
                  }}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </Text>
                </div>
                <Text style={{
                  fontSize: 12,
                  color: '#665555',
                  wordBreak: 'break-word',
                  lineHeight: 1.5,
                  paddingLeft: 18,
                }}>
                  {entry.message}
                </Text>
              </div>
            ))}
          </Space>
        )}
      </div>
    </div>
  );
};

export default LogCard;
