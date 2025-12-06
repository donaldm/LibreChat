import { useEffect, useState } from 'react';
import { v4 } from 'uuid';
import { SSE } from 'sse.js';
import { useSetRecoilState } from 'recoil';
import {
  QueryKeys,
  request,
  Constants,
  /* @ts-ignore */
  createPayload,
  LocalStorageKeys,
  removeNullishValues,
} from 'librechat-data-provider';
import type { TMessage, TPayload, TSubmission, EventSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData } from '~/common';
import { useGenTitleMutation, useGetStartupConfig, useGetUserBalance } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import useEventHandlers from './useEventHandlers';
import store from '~/store';
import { useQueryClient } from '@tanstack/react-query';
import type { MCPServerStatus, MCPConnectionStatusResponse } from 'librechat-data-provider';

const clearDraft = (conversationId?: string | null) => {
  if (conversationId) {
    localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${conversationId}`);
    localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${conversationId}`);
  } else {
    localStorage.removeItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`);
    localStorage.removeItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`);
  }
};

type ChatHelpers = Pick<
  EventHandlerParams,
  | 'setMessages'
  | 'getMessages'
  | 'setConversation'
  | 'setIsSubmitting'
  | 'newConversation'
  | 'resetLatestMessage'
>;

export default function useSSE(
  submission: TSubmission | null,
  chatHelpers: ChatHelpers,
  isAddedRequest = false,
  runIndex = 0,
) {
  console.info('[useSSE] hook invoked', {
    hasSubmission: submission != null,
    isAddedRequest,
    runIndex,
  });

  const genTitle = useGenTitleMutation();
  const setActiveRunId = useSetRecoilState(store.activeRunFamily(runIndex));
  const queryClient = useQueryClient();

  const { token, isAuthenticated } = useAuthContext();
  const [completed, setCompleted] = useState(new Set());
  const setAbortScroll = useSetRecoilState(store.abortScrollFamily(runIndex));
  const setShowStopButton = useSetRecoilState(store.showStopButtonByIndex(runIndex));

  const {
    setMessages,
    getMessages,
    setConversation,
    setIsSubmitting,
    newConversation,
    resetLatestMessage,
  } = chatHelpers;

  const {
    clearStepMaps,
    stepHandler,
    syncHandler,
    finalHandler,
    errorHandler,
    messageHandler,
    contentHandler,
    createdHandler,
    attachmentHandler,
    abortConversation,
  } = useEventHandlers({
    genTitle,
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
    resetLatestMessage,
  });

  const { data: startupConfig } = useGetStartupConfig();
  const balanceQuery = useGetUserBalance({
    enabled: !!isAuthenticated && startupConfig?.balance?.enabled,
  });

  const applyStreamedConnectionStatus = (update: unknown) => {
    if (update == null) {
      return;
    }

    const resolvedStatus: Record<string, MCPServerStatus> = {};

    if (typeof update === 'object' && !Array.isArray(update)) {
      const record = update as Record<string, unknown>;

      if (
        typeof record.serverName === 'string' &&
        typeof record.connectionStatus === 'string'
      ) {
        resolvedStatus[record.serverName] = {
          connectionState: record.connectionStatus as MCPServerStatus['connectionState'],
          requiresOAuth: Boolean(record.requiresOAuth),
        };
      } else {
        for (const [serverName, status] of Object.entries(record)) {
          if (status && typeof status === 'object' && 'connectionState' in status) {
            const { connectionState, requiresOAuth } = status as MCPServerStatus;
            if (typeof connectionState === 'string') {
              resolvedStatus[serverName] = {
                connectionState,
                requiresOAuth: Boolean(requiresOAuth),
              };
            }
          }
        }
      }
    }

    if (Object.keys(resolvedStatus).length === 0) {
      return;
    }

    queryClient.setQueryData<MCPConnectionStatusResponse | undefined>(
      [QueryKeys.mcpConnectionStatus],
      (previous) => {
        const existing = previous?.connectionStatus ?? {};
        return {
          success: true,
          connectionStatus: { ...existing, ...resolvedStatus },
        };
      },
    );
  };

  useEffect(() => {
    if (submission == null || Object.keys(submission).length === 0) {
      console.info('[useSSE] no submission provided, skipping stream setup', {
        hasSubmission: submission != null,
        submissionKeys: submission ? Object.keys(submission) : [],
      });
      return;
    }

    let { userMessage } = submission;

    const payloadData = createPayload(submission);
    let { payload } = payloadData;
    payload = removeNullishValues(payload) as TPayload;

    console.info('[useSSE] preparing SSE stream', {
      server: payloadData.server,
      payloadKeys: Object.keys(payload ?? {}),
      conversationId: submission.conversation?.conversationId,
      messageCount: submission.messages?.length,
      hasInitialResponse: Boolean(submission.initialResponse),
    });

    let textIndex = null;
    clearStepMaps();

    const sse = new SSE(payloadData.server, {
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });

    console.info('[useSSE] SSE instance created', {
      url: payloadData.server,
      readyState: sse.readyState,
    });

    sse.addEventListener('attachment', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        attachmentHandler({ data, submission: submission as EventSubmission });
      } catch (error) {
        console.error(error);
      }
    });

    const normalizeJsonRpc = (data: unknown): {
      payload: Record<string, unknown> | unknown;
      envelope: Record<string, unknown> | unknown;
    } => {
      if (data && typeof data === 'object' && (data as Record<string, unknown>).jsonrpc === '2.0') {
        const record = data as Record<string, unknown>;

        if ('result' in record) {
          const result = record.result;
          if (result && typeof result === 'object') {
            return { payload: { ...(result as Record<string, unknown>), id: record.id }, envelope: record };
          }

          return { payload: result, envelope: record };
        }

        if ('params' in record) {
          return { payload: record.params, envelope: record };
        }

        return { payload: record, envelope: record };
      }

      return { payload: data, envelope: data };
    };

    const logStreamableDebug = (message: string, details?: Record<string, unknown>) => {
      try {
        // Using console.info so these diagnostics always appear in typical browser console filters
        console.info(`[SSE][streamable-http] ${message}`, details ?? {});
      } catch (error) {
        console.error('Failed to log streamable HTTP debug info', error);
      }
    };

    logStreamableDebug('Initialized streamable HTTP SSE handler', {
      server: payloadData.server,
      payloadKeys: Object.keys(payload ?? {}),
    });

    const applyStreamableHTTPResult = async (payload: unknown, envelope?: unknown) => {
      const payloadRecord = (payload ?? {}) as Record<string, unknown>;
      const envelopeRecord = (envelope ?? payloadRecord) as Record<string, unknown>;
      const result =
        Array.isArray(payloadRecord?.content) || payloadRecord?.content == null
          ? (payloadRecord as Record<string, unknown>)
          : ((payloadRecord?.result ?? {}) as Record<string, unknown>);

      if (!Array.isArray(result?.content)) {
        logStreamableDebug('Ignoring streamable HTTP result without content array', {
          hasResult: Boolean(result),
          keys: Object.keys(result ?? {}),
          envelopeKeys: Object.keys(envelopeRecord ?? {}),
        });
        return false;
      }

      const conversationId =
        (payloadRecord.conversationId as string | undefined) ??
        (envelopeRecord.conversationId as string | undefined) ??
        submission.conversation?.conversationId ??
        userMessage.conversationId ??
        Constants.NEW_CONVO;

      logStreamableDebug('Processing streamable HTTP final payload', {
        conversationId,
        payloadKeys: Object.keys(payloadRecord ?? {}),
        envelopeKeys: Object.keys(envelopeRecord ?? {}),
        contentLength: Array.isArray(result.content) ? result.content.length : 0,
        hasMessageId: Boolean(payloadRecord.messageId ?? envelopeRecord.messageId),
      });

      const requestMessage: TMessage = {
        ...userMessage,
        conversationId,
        messageId: userMessage.messageId ?? v4(),
        parentMessageId: userMessage.parentMessageId ?? Constants.NO_PARENT,
      } as TMessage;

      const responseMessage = {
        ...(submission.initialResponse as TMessage),
        ...envelopeRecord,
        ...payloadRecord,
        messageId: (payloadRecord.messageId as string | undefined) ??
          (envelopeRecord.messageId as string | undefined) ??
          submission.initialResponse?.messageId ??
          v4(),
        parentMessageId:
          (payloadRecord.parentMessageId as string | undefined) ??
          (envelopeRecord.parentMessageId as string | undefined) ??
          requestMessage.messageId,
        conversationId,
        content: result.content as TMessage['content'],
      } as TMessage;

      const existingMessages = getMessages() ?? submission.messages ?? [];
      const runMessages = [...existingMessages];

      if (!runMessages.some(({ messageId }) => messageId === requestMessage.messageId)) {
        runMessages.push(requestMessage);
      }

      const initialResponse = submission.initialResponse as TMessage | undefined;
      if (initialResponse && !runMessages.some(({ messageId }) => messageId === initialResponse.messageId)) {
        runMessages.push(initialResponse);
      }

      if (!runMessages.some(({ messageId }) => messageId === responseMessage.messageId)) {
        runMessages.push(responseMessage);
      }

      const finalData = {
        requestMessage,
        responseMessage,
        runMessages,
        conversation: { ...submission.conversation, conversationId },
      } satisfies Parameters<typeof finalHandler>[0];

      logStreamableDebug('Invoking finalHandler with streamable HTTP context', {
        requestId: requestMessage.messageId,
        responseId: responseMessage.messageId,
        runMessages: runMessages.length,
      });

      try {
        await Promise.resolve(
          finalHandler(finalData, { ...submission, userMessage } as EventSubmission),
        );
      } catch (error) {
        console.error('Error handling streamable HTTP result:', error);
        setIsSubmitting(false);
        setShowStopButton(false);
      }

      await queryClient.invalidateQueries({ queryKey: [QueryKeys.messages, conversationId] });
      await queryClient.refetchQueries({ queryKey: [QueryKeys.messages, conversationId] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.conversation, conversationId] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.allConversations] });

      const refreshedMessages = queryClient.getQueryData<TMessage[]>([
        QueryKeys.messages,
        conversationId,
      ]);
      logStreamableDebug('Streamable HTTP refresh complete', {
        refreshedCount: refreshedMessages?.length ?? 0,
      });
      if (refreshedMessages && refreshedMessages.length > 0) {
        setMessages([...refreshedMessages]);
      }
      setIsSubmitting(false);
      setShowStopButton(false);
      return true;
    };

    sse.addEventListener('message', async (e: MessageEvent) => {
      const rawData = JSON.parse(e.data);
      const { payload, envelope } = normalizeJsonRpc(rawData);
      const data = (payload ?? {}) as Record<string, unknown>;
      const envelopeData = (envelope ?? {}) as Record<string, unknown>;

      logStreamableDebug('Received SSE message', {
        rawKeys: Object.keys((rawData as Record<string, unknown>) ?? {}),
        normalizedKeys: Object.keys(data ?? {}),
        envelopeKeys: Object.keys(envelopeData ?? {}),
        hasFinalFlag: Boolean((data as Record<string, unknown>)?.final),
      });

      applyStreamedConnectionStatus(
        data?.connectionStatus ??
          data?.mcpConnectionStatus ??
          data?.connection_state ??
          envelopeData?.connectionStatus ??
          envelopeData?.mcpConnectionStatus ??
          envelopeData?.connection_state,
      );

      if (data?.final != null) {
        clearDraft(submission.conversation?.conversationId);
        const { plugins } = data;
        try {
          finalHandler(data, { ...submission, plugins } as EventSubmission);
        } catch (error) {
          console.error('Error in finalHandler:', error);
          setIsSubmitting(false);
          setShowStopButton(false);
        }
        (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();
        console.log('final', data);
        return;
      } else if (await applyStreamableHTTPResult(data, envelopeData)) {
        return;
      } else if (data?.created != null) {
        const runId = v4();
        setActiveRunId(runId);
        userMessage = {
          ...userMessage,
          ...data.message,
          overrideParentMessageId: userMessage.overrideParentMessageId,
        };

        createdHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data?.event != null) {
        stepHandler(data, { ...submission, userMessage } as EventSubmission);

        if (data.event === 'on_run_step_completed') {
          const eventConversationId =
            (data?.result?.conversation_id as string | undefined) ??
            (data?.result?.tool_call?.conversationId as string | undefined) ??
            submission.conversation?.conversationId ??
            userMessage.conversationId;

          if (eventConversationId) {
            await queryClient.invalidateQueries({
              queryKey: [QueryKeys.messages, eventConversationId],
            });
            await queryClient.refetchQueries({
              queryKey: [QueryKeys.messages, eventConversationId],
            });
            queryClient.invalidateQueries({
              queryKey: [QueryKeys.conversation, eventConversationId],
            });
            queryClient.invalidateQueries({ queryKey: [QueryKeys.allConversations] });
          }

          setIsSubmitting(false);
          setShowStopButton(false);
        }
      } else if (data?.sync != null) {
        const runId = v4();
        setActiveRunId(runId);
        /* synchronize messages to Assistants API as well as with real DB ID's */
        syncHandler(data, { ...submission, userMessage } as EventSubmission);
      } else if (data?.type != null) {
        const { text, index } = data;
        if (text != null && index !== textIndex) {
          textIndex = index;
        }

        contentHandler({ data, submission: submission as EventSubmission });
      } else {
        const text = data?.text ?? data?.response;
        const { plugin, plugins } = data ?? {};

        const initialResponse = {
          ...(submission.initialResponse as TMessage),
          parentMessageId: data?.parentMessageId,
          messageId: data?.messageId,
        };

        if (data?.message != null) {
          messageHandler(text, { ...submission, plugin, plugins, userMessage, initialResponse });
        }
      }
    });

    sse.addEventListener('open', () => {
      setAbortScroll(false);
      console.log('connection is opened');
    });

    sse.addEventListener('cancel', async () => {
      const streamKey = (submission as TSubmission | null)?.['initialResponse']?.messageId;
      if (completed.has(streamKey)) {
        setIsSubmitting(false);
        setCompleted((prev) => {
          prev.delete(streamKey);
          return new Set(prev);
        });
        return;
      }

      setCompleted((prev) => new Set(prev.add(streamKey)));
      const latestMessages = getMessages();
      const conversationId = latestMessages?.[latestMessages.length - 1]?.conversationId;
      try {
        await abortConversation(
          conversationId ??
            userMessage.conversationId ??
            submission.conversation?.conversationId ??
            '',
          submission as EventSubmission,
          latestMessages,
        );
      } catch (error) {
        console.error('Error during abort:', error);
        setIsSubmitting(false);
        setShowStopButton(false);
      }
    });

    sse.addEventListener('error', async (e: MessageEvent) => {
      /* @ts-ignore */
      if (e.responseCode === 401) {
        /* token expired, refresh and retry */
        try {
          const refreshResponse = await request.refreshToken();
          const token = refreshResponse?.token ?? '';
          if (!token) {
            throw new Error('Token refresh failed.');
          }
          sse.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          };

          request.dispatchTokenUpdatedEvent(token);
          sse.stream();
          return;
        } catch (error) {
          /* token refresh failed, continue handling the original 401 */
          console.log(error);
        }
      }

      console.log('error in server stream.');
      (startupConfig?.balance?.enabled ?? false) && balanceQuery.refetch();

      let data: TResData | undefined = undefined;
      try {
        data = JSON.parse(e.data) as TResData;
        applyStreamedConnectionStatus(
          data?.connectionStatus ?? data?.mcpConnectionStatus ?? data?.connection_state,
        );
      } catch (error) {
        console.error(error);
        console.log(e);
        setIsSubmitting(false);
      }

      errorHandler({ data, submission: { ...submission, userMessage } as EventSubmission });
    });

    setIsSubmitting(true);
    sse.stream();

    return () => {
      const isCancelled = sse.readyState <= 1;
      sse.close();
      if (isCancelled) {
        const e = new Event('cancel');
        /* @ts-ignore */
        sse.dispatchEvent(e);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);
}
