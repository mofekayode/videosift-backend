# Frontend to Backend Migration Checklist

## Migration Status

### Phase 1: Setup and Configuration
- [x] Add NEXT_PUBLIC_BACKEND_URL to frontend .env.local
- [x] Update CORS settings if needed
- [x] Verify backend is running on port 4000
- [x] Test basic connectivity

### Phase 2: Monitoring & Read-Only Endpoints (Low Risk)
- [x] GET /api/monitor/status → Backend /api/monitor/stats ✅ WORKING!
- [x] GET /api/cron-health → Not used, skipping
- [x] GET /api/channel/monitor → Keep in frontend (direct Supabase query)

### Phase 3: Channel Processing (Important)
- [x] POST /api/channel/process → Already using backend via processChannel() ✅
- [ ] Verify channel processing works end-to-end

### Phase 4: Video Processing Endpoints
- [ ] POST /api/video/transcript → Backend /api/videos/process
- [ ] GET /api/video/metadata → Keep in frontend (simple Supabase query)

### Phase 5: Chat Endpoints (Critical)
- [ ] POST /api/chat-stream → Backend /api/chat/stream
- [ ] POST /api/chat-channel-stream → Backend /api/chat/channel/stream
- [ ] POST /api/chat → Remove (use streaming version)
- [ ] POST /api/chat-simple → Remove (use streaming version)

### Phase 6: Channel Processing Endpoints
- [ ] POST /api/channel/process → Backend /api/channels/process
- [ ] GET /api/channel/monitor → Backend /api/monitor/stats

### Phase 7: Queue Management (New Features)
- [ ] Implement queue UI using Backend /api/queue/*
- [ ] Add channel queue position tracking
- [ ] Add video queue management

### Phase 8: Cleanup
- [ ] Remove /api/cron/* from frontend (handled by backend)
- [ ] Remove duplicate processing logic from frontend
- [ ] Update documentation

## Current Migration Step: Phase 1

Let's start with the setup.