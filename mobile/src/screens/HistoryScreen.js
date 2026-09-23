import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import api from '../api/client';
import { colors, radius, shadow } from '../theme';
import BottomNav from '../components/BottomNav';
import StatusPill from '../components/StatusPill';
import FadeIn from '../components/FadeIn';
import AppHeader from '../components/AppHeader';
import Skeleton from '../components/Skeleton';
import { formatDuration, liveDurationSeconds } from '../utils/duration';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'ongoing', label: 'On-going' },
  { key: 'completed', label: 'Completed' },
  { key: 'present', label: 'Present' },
  { key: 'late', label: 'Late' },
  { key: 'absent', label: 'Absent' },
];

export default function HistoryScreen({ navigation }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/attendance/my-history');
      setRecords(data.data || []);
    } catch (err) {
      setRecords([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Ticks any still-open ("on-going") record's Duration cell forward once a
  // second, since its total keeps accumulating in real time until the
  // employee leaves the geofence (or re-enters it after having left).
  useEffect(() => {
    const hasOpenSession = records.some((r) => !r.time_out);
    if (!hasOpenSession) return undefined;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [records]);

  const filteredRecords = useMemo(() => {
    switch (filter) {
      case 'ongoing': return records.filter((r) => !r.time_out);
      case 'completed': return records.filter((r) => !!r.time_out);
      case 'present': return records.filter((r) => r.attendance_status === 'Present');
      case 'late': return records.filter((r) => r.attendance_status === 'Late');
      case 'absent': return records.filter((r) => r.attendance_status === 'Absent');
      default: return records;
    }
  }, [records, filter]);

  return (
    <View style={styles.flex}>
      <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
        <AppHeader title="Attendance Logs" />
      </View>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
        data={FILTERS}
        keyExtractor={(f) => f.key}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.filterChip, filter === item.key && styles.filterChipActive]}
            onPress={() => setFilter(item.key)}
            activeOpacity={0.7}
          >
            <Text style={[styles.filterChipText, filter === item.key && styles.filterChipTextActive]}>{item.label}</Text>
          </TouchableOpacity>
        )}
      />
      {loading ? (
        <Skeleton rows={4} style={{ padding: 20, paddingTop: 12 }} />
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={{ padding: 20, paddingTop: 12 }}
          data={filteredRecords}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          ListEmptyComponent={<Text style={styles.empty}>📋{'\n'}No attendance history found{filter !== 'all' ? ' for this filter.' : '.'}</Text>}
          renderItem={({ item, index }) => {
            const completed = !!item.time_out;
            const durationSeconds = liveDurationSeconds(item);
            return (
              <FadeIn delay={Math.min(index, 6) * 40}>
                <View style={styles.card}>
                  <View style={styles.cardTopRow}>
                    <Text style={styles.eventTitle}>{item.event_title || 'N/A'}</Text>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      {item.attendance_status && (
                        <StatusPill
                          label={item.attendance_status}
                          variant={item.attendance_status === 'Present' ? 'success' : (item.attendance_status === 'Late' ? 'waiting' : 'danger')}
                        />
                      )}
                      <StatusPill label={completed ? 'Completed' : 'On-going'} variant={completed ? 'success' : 'waiting'} />
                    </View>
                  </View>
                  <Text style={styles.metaLine}>📅 {item.attendance_date}</Text>
                  <Text style={styles.metaLine}>
                    <Text style={{ color: colors.success }}>In: {item.time_in ? new Date(item.time_in).toLocaleTimeString() : '--:--'}</Text>
                    {'  |  '}
                    <Text style={{ color: colors.error }}>Out: {item.time_out ? new Date(item.time_out).toLocaleTimeString() : '--:--'}</Text>
                  </Text>
                  <View style={styles.durationRow}>
                    <Text style={styles.durationLabel}>Duration</Text>
                    <Text style={[styles.durationValue, !completed && { color: colors.warningText }]}>
                      {formatDuration(durationSeconds)}
                    </Text>
                    {item.session_count > 1 && (
                      <Text style={styles.sessionCountText}>· {item.session_count} sessions</Text>
                    )}
                  </View>
                </View>
              </FadeIn>
            );
          }}
        />
      )}
      <BottomNav active="History" navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: { fontSize: 20, fontWeight: '800', color: colors.textMain },
  filterRow: { flexGrow: 0, marginTop: 14 },
  filterChip: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 12, fontWeight: '700', color: colors.textSub },
  filterChipTextActive: { color: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  empty: { textAlign: 'center', color: colors.textSub, marginTop: 40, fontSize: 13 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 16,
    marginBottom: 12, borderWidth: 1, borderColor: colors.border, ...shadow,
  },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eventTitle: { fontWeight: '700', color: colors.textMain, fontSize: 13, flex: 1, marginRight: 8 },
  metaLine: { fontSize: 12, color: colors.textSub, marginTop: 2 },
  durationRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: colors.bg,
  },
  durationLabel: { fontSize: 11, fontWeight: '700', color: colors.textSub, textTransform: 'uppercase', letterSpacing: 0.4, marginRight: 8 },
  durationValue: { fontSize: 14, fontWeight: '800', color: colors.primary },
  sessionCountText: { fontSize: 11, color: colors.textSub, fontWeight: '600', marginLeft: 6 },
});
