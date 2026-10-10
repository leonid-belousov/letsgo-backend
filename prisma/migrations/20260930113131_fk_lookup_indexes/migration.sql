-- CreateIndex
CREATE INDEX "Booking_configurationId_idx" ON "Booking"("configurationId");

-- CreateIndex
CREATE INDEX "ClubEntry_clubId_idx" ON "ClubEntry"("clubId");

-- CreateIndex
CREATE INDEX "Event_bookingId_idx" ON "Event"("bookingId");

-- CreateIndex
CREATE INDEX "Event_venueId_idx" ON "Event"("venueId");

-- CreateIndex
CREATE INDEX "ModerationAction_reportId_idx" ON "ModerationAction"("reportId");

-- CreateIndex
CREATE INDEX "PitchConfigurationPart_partId_idx" ON "PitchConfigurationPart"("partId");

-- CreateIndex
CREATE INDEX "PitchOccupancy_calendarBlockId_idx" ON "PitchOccupancy"("calendarBlockId");

-- CreateIndex
CREATE INDEX "PostMedia_mediaId_idx" ON "PostMedia"("mediaId");
