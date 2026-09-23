import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { getGeofences } from '../api/client';
import { colors, radius, shadow } from '../theme';
import BottomNav from '../components/BottomNav';
import StatusPill from '../components/StatusPill';
import ScheduleMapModal from '../components/ScheduleMapModal';
import FadeIn from '../components/FadeIn';
import Skeleton from '../components/Skeleton';
import AppHeader from '../components/AppHeader';
import { scheduleTodayEventReminders } from '../utils/eventReminders';

function isToday(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function fmtTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtShortDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function DashboardScreen({ navigation }) {
  const { employee } = useAuth();
  const [geofences, setGeofences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getGeofences();
      setGeofences(res.data || []);
    } catch (err) {
      // Non-fatal — dashboard still renders with empty schedule.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-fetch whenever the Dashboard comes back into focus (e.g. returning from
  // Attendance/History/Profile), and poll every 30s while it stays visible, so a
  // newly admin-created event/geofence shows up without needing an app restart.
  useFocusEffect(
    useCallback(() => {
      load();
      const interval = setInterval(load, 30000);
      return () => clearInterval(interval);
    }, [load])
  );

  const activeEvent = geofences.find((g) => g.computed_status === 'active');
  const todaySchedule = geofences.filter((g) => g.computed_status !== 'expired' && isToday(g.start_datetime));
  const upcoming = geofences.filter((g) => g.computed_status === 'upcoming' && !isToday(g.start_datetime));

  // Reminds the employee about today's event(s) — a "starting soon" local
  // notification ahead of time, or a "happening now" nudge if it's already
  // active — so they don't need to have the app open to be reminded.
  useEffect(() => {
    if (todaySchedule.length) scheduleTodayEventReminders(todaySchedule);
  }, [todaySchedule]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstName = (employee?.full_name || 'User').split(' ')[0];

  return (
    <View style={styles.flex}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ padding: 20, paddingBottom: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        <FadeIn>
          <AppHeader />
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.welcome}>Welcome, {firstName}!</Text>
              <Text style={styles.geoStatus}>
                Geofence Status: <Text style={{ color: activeEvent ? colors.success : colors.textSub, fontWeight: '800' }}>
                  {loading ? 'CHECKING…' : activeEvent ? 'ACTIVE' : 'NO ACTIVE EVENT'}
                </Text>
              </Text>
            </View>
            <TouchableOpacity style={styles.avatarBtn} onPress={() => navigation.navigate('Profile')} activeOpacity={0.75}>
              <Text style={styles.avatarBtnIcon}>👤</Text>
            </TouchableOpacity>
          </View>
        </FadeIn>

        {/* Active check-in card — indigo brand card mirroring the admin dashboard's stat/hero cards */}
        <FadeIn delay={60}>
          <View style={styles.attendanceCard}>
            <Text style={styles.attendanceLabel}>Ongoing Now</Text>
            <Text style={styles.attendanceEventName}>{activeEvent ? activeEvent.title : 'No active event'}</Text>
            <Text style={styles.attendanceVenue}>📍 {activeEvent ? (activeEvent.venue || '--') : '--'}</Text>
            <TouchableOpacity
              style={[styles.btnPrimaryOnCard, !activeEvent && styles.btnDisabled]}
              disabled={!activeEvent}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('Attendance', activeEvent ? { geofenceId: activeEvent.id } : undefined)}
            >
              <Text style={styles.btnPrimaryOnCardText}>{activeEvent ? 'Mark Attendance' : 'No Active Event'}</Text>
            </TouchableOpacity>
          </View>
        </FadeIn>

        <Text style={styles.sectionTitle}>Today's Schedule</Text>
        {loading ? (
          <Skeleton rows={2} />
        ) : (
          <FadeIn delay={100}>
            <View style={styles.listCard}>
              {todaySchedule.length === 0 && <Text style={styles.emptyText}>No events scheduled today.</Text>}
              {todaySchedule.map((g, i) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.eventItem, i === todaySchedule.length - 1 && styles.eventItemLast]}
                  onPress={() => navigation.navigate('Attendance', { geofenceId: g.id })}
                  activeOpacity={0.6}
                >
                  <View style={styles.eventIconWrap}>
                    <Text style={styles.eventIcon}>📅</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventTitle}>{g.title}</Text>
                    <Text style={styles.eventMeta}>{fmtTime(g.start_datetime)} • {g.venue || 'TBA'}</Text>
                  </View>
                  <StatusPill
                    label={g.computed_status === 'active' ? 'Ongoing' : 'Soon'}
                    variant={g.computed_status === 'active' ? 'success' : 'soon'}
                  />
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
          </FadeIn>
        )}

        <Text style={styles.sectionTitle}>Upcoming Schedule</Text>
        {loading ? (
          <Skeleton rows={2} style={{ marginBottom: 20 }} />
        ) : (
          <FadeIn delay={150}>
            <View style={[styles.listCard, { marginBottom: 20 }]}>
              {upcoming.length === 0 && <Text style={styles.emptyText}>No upcoming events.</Text>}
              {upcoming.map((g, i) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.eventItem, i === upcoming.length - 1 && styles.eventItemLast]}
                  onPress={() => setSelectedSchedule(g)}
                  activeOpacity={0.6}
                >
                  <View style={styles.eventIconWrap}>
                    <Text style={styles.eventIcon}>🗓️</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventTitle}>{g.title}</Text>
                    <Text style={styles.eventMeta}>{fmtShortDate(g.start_datetime)} • {g.venue || 'TBA'}</Text>
                  </View>
                  <StatusPill label="Next" />
                  <Text style={styles.chevron}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
          </FadeIn>
        )}
      </ScrollView>

      <ScheduleMapModal
        visible={!!selectedSchedule}
        schedule={selectedSchedule}
        onClose={() => setSelectedSchedule(null)}
      />

      <BottomNav active="Dashboard" navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 18 },
  welcome: { fontSize: 22, fontWeight: '800', color: colors.textMain },
  geoStatus: { fontSize: 12, color: colors.textSub, marginTop: 4, fontWeight: '600' },
  avatarBtn: {
    width: 44, height: 44, borderRadius: 16, backgroundColor: colors.white,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
    ...shadow,
  },
  avatarBtnIcon: { fontSize: 18 },
  attendanceCard: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: 24,
    marginBottom: 14,
    ...shadow,
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
  },
  attendanceLabel: { fontSize: 10, fontWeight: '800', color: 'rgba(255,255,255,0.7)', letterSpacing: 1, textTransform: 'uppercase' },
  attendanceEventName: { color: '#fff', fontSize: 19, fontWeight: '800', marginTop: 6, marginBottom: 4 },
  attendanceVenue: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600' },
  btnPrimaryOnCard: { backgroundColor: '#fff', borderRadius: radius.md, padding: 15, alignItems: 'center', marginTop: 18 },
  btnDisabled: { opacity: 0.5 },
  btnPrimaryOnCardText: { color: colors.primary, fontWeight: '800', fontSize: 14 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 20, marginBottom: 10 },
  listCard: {
    backgroundColor: colors.white, borderRadius: radius.lg, paddingHorizontal: 16,
    borderWidth: 1, borderColor: colors.border, ...shadow,
  },
  eventItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.bg, gap: 12 },
  eventItemLast: { borderBottomWidth: 0 },
  eventIconWrap: {
    width: 38, height: 38, borderRadius: 12, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  eventIcon: { fontSize: 16 },
  eventTitle: { fontSize: 13, color: colors.textMain, fontWeight: '700' },
  eventMeta: { fontSize: 11, color: colors.textSub, marginTop: 2, fontWeight: '600' },
  chevron: { fontSize: 20, color: colors.textSub, marginLeft: 2 },
  emptyText: { color: colors.textSub, fontSize: 12, paddingVertical: 18, textAlign: 'center', fontWeight: '600' },
});
