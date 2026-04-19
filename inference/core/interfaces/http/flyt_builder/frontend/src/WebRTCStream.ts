// Thin browser-side helper that hands a webcam `MediaStream` to the
// inference server over WebRTC and receives a processed stream back.
//
// Flow:
//   1. getUserMedia to capture local camera (+ mic suppressed).
//   2. Create RTCPeerConnection, add tracks, open a data channel for
//      prediction JSON.
//   3. Generate an SDP offer, POST to /inference_pipelines/initialise_webrtc
//      with the workflow spec.
//   4. Receive answer SDP, complete the connection. Remote tracks arrive
//      via `ontrack` — caller attaches them to a <video> element.

import { initPipelineWebRTC, terminatePipeline } from "./api";

export type WebRTCHandle = {
  pipelineId: string;
  localStream: MediaStream;
  remoteStream: MediaStream;
  pc: RTCPeerConnection;
  stop: () => Promise<void>;
  onPredictions: (cb: (data: any) => void) => void;
};

export async function startWebRTCStream(opts: {
  specification: any;
  deviceId?: string;
  width?: number;
  height?: number;
  imageInputName?: string;
  workflowsParameters?: Record<string, unknown>;
}): Promise<WebRTCHandle> {
  const constraints: MediaStreamConstraints = {
    video: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      width: opts.width ? { ideal: opts.width } : undefined,
      height: opts.height ? { ideal: opts.height } : undefined,
    },
    audio: false,
  };
  const localStream = await navigator.mediaDevices.getUserMedia(constraints);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  for (const t of localStream.getVideoTracks()) {
    pc.addTrack(t, localStream);
  }

  const remoteStream = new MediaStream();
  pc.ontrack = (e) => {
    for (const t of e.streams[0]?.getTracks() ?? []) {
      remoteStream.addTrack(t);
    }
  };

  const dc = pc.createDataChannel("predictions");
  const predictionListeners: Array<(data: any) => void> = [];
  dc.onmessage = (e) => {
    let parsed: any = e.data;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      /* leave raw */
    }
    for (const cb of predictionListeners) cb(parsed);
  };

  const offer = await pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: false,
  });
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering so the SDP we send is complete.
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    // Safety timeout — don't wait forever for a non-trickle ICE box.
    window.setTimeout(resolve, 2000);
  });

  const localSdp = pc.localDescription!;
  const { pipeline_id, answer } = await initPipelineWebRTC({
    specification: opts.specification,
    offer: { type: localSdp.type as RTCSdpType, sdp: localSdp.sdp },
    image_input_name: opts.imageInputName,
    workflows_parameters: opts.workflowsParameters,
  });
  await pc.setRemoteDescription(new RTCSessionDescription(answer));

  const handle: WebRTCHandle = {
    pipelineId: pipeline_id,
    localStream,
    remoteStream,
    pc,
    onPredictions: (cb) => {
      predictionListeners.push(cb);
    },
    stop: async () => {
      try {
        for (const t of localStream.getTracks()) t.stop();
      } catch {
        /* ignore */
      }
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      await terminatePipeline(pipeline_id);
    },
  };
  return handle;
}
