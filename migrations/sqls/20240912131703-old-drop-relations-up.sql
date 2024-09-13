insert into drop_relations (parent_id, child_id, child_serial_no, wave_id, parent_deleted)
with s1 as (
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l1.id as child_id,
        replies_l1.serial_no as child_serial_no,
        replies_l1.wave_id,
        false as parent_deleted
    from drops replies_l1 where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l2.id as child_id,
        replies_l2.serial_no as child_serial_no,
        replies_l2.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l2.id as child_id,
        replies_l2.serial_no as child_serial_no,
        replies_l2.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l3.id as child_id,
        replies_l3.serial_no as child_serial_no,
        replies_l3.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l3.id as child_id,
        replies_l3.serial_no as child_serial_no,
        replies_l3.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l3.id as child_id,
        replies_l3.serial_no as child_serial_no,
        replies_l3.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l4.id as child_id,
        replies_l4.serial_no as child_serial_no,
        replies_l4.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l4.id as child_id,
        replies_l4.serial_no as child_serial_no,
        replies_l4.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l4.id as child_id,
        replies_l4.serial_no as child_serial_no,
        replies_l4.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l4.id as child_id,
        replies_l4.serial_no as child_serial_no,
        replies_l4.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l5.id as child_id,
        replies_l5.serial_no as child_serial_no,
        replies_l5.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l5.id as child_id,
        replies_l5.serial_no as child_serial_no,
        replies_l5.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l5.id as child_id,
        replies_l5.serial_no as child_serial_no,
        replies_l5.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l5.id as child_id,
        replies_l5.serial_no as child_serial_no,
        replies_l5.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l5.id as child_id,
        replies_l5.serial_no as child_serial_no,
        replies_l5.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l5.id as child_id,
        replies_l5.serial_no as child_serial_no,
        replies_l5.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l6.id as child_id,
        replies_l6.serial_no as child_serial_no,
        replies_l6.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l6.id as child_id,
        replies_l6.serial_no as child_serial_no,
        replies_l6.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l6.id as child_id,
        replies_l6.serial_no as child_serial_no,
        replies_l6.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l6.id as child_id,
        replies_l6.serial_no as child_serial_no,
        replies_l6.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l6.id as child_id,
        replies_l6.serial_no as child_serial_no,
        replies_l6.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l6.id as child_id,
        replies_l6.serial_no as child_serial_no,
        replies_l6.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l7.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l7.id as child_id,
        replies_l7.serial_no as child_serial_no,
        replies_l7.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l8.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l7.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l8.id as child_id,
        replies_l8.serial_no as child_serial_no,
        replies_l8.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l8.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l9.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l7.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l9.id as child_id,
        replies_l9.serial_no as child_serial_no,
        replies_l9.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l10.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l9.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l8.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l7.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l10.id as child_id,
        replies_l10.serial_no as child_serial_no,
        replies_l10.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l11.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l10.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l9.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l8.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l7.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l11.id as child_id,
        replies_l11.serial_no as child_serial_no,
        replies_l11.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l12.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l11.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l10.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l9.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l8.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l7.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l6.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l5.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l4.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l3.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l2.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
    union all
    select
        replies_l1.reply_to_drop_id as parent_id,
        replies_l12.id as child_id,
        replies_l12.serial_no as child_serial_no,
        replies_l12.wave_id,
        false as parent_deleted
    from drops replies_l1
             join drops replies_l2 on replies_l2.reply_to_drop_id = replies_l1.id
             join drops replies_l3 on replies_l3.reply_to_drop_id = replies_l2.id
             join drops replies_l4 on replies_l4.reply_to_drop_id = replies_l3.id
             join drops replies_l5 on replies_l5.reply_to_drop_id = replies_l4.id
             join drops replies_l6 on replies_l6.reply_to_drop_id = replies_l5.id
             join drops replies_l7 on replies_l7.reply_to_drop_id = replies_l6.id
             join drops replies_l8 on replies_l8.reply_to_drop_id = replies_l7.id
             join drops replies_l9 on replies_l9.reply_to_drop_id = replies_l8.id
             join drops replies_l10 on replies_l10.reply_to_drop_id = replies_l9.id
             join drops replies_l11 on replies_l11.reply_to_drop_id = replies_l10.id
             join drops replies_l12 on replies_l12.reply_to_drop_id = replies_l11.id
    where replies_l1.reply_to_drop_id is not null
) select s1.parent_id, s1.child_id, s1.child_serial_no, s1.wave_id, s1.parent_deleted from s1
                                                                                               left join drop_relations s2 on s1.parent_id = s2.parent_id and s1.child_id = s2.child_id and s1.wave_id = s2.wave_id
where s2.parent_id is null;